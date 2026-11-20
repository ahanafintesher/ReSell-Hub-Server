const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { getStripeInstance } = require("../config/stripe");

let recoveryTimer = null;

/**
 * Calculates bounded exponential backoff delay based on attempt count.
 * Base delay: 30 seconds (configurable)
 * Max delay: 1 hour (3600000 ms)
 */
function calculateBackoffDelay(attempts, baseDelayMs = 30000, maxDelayMs = 3600000) {
  const safeAttempts = Math.max(1, attempts || 1);
  return Math.min(baseDelayMs * Math.pow(2, safeAttempts - 1), maxDelayMs);
}

/**
 * Derives a stable, deterministic idempotency key for refunds.
 */
function getRefundIdempotencyKey(identifier, type = "duplicate") {
  return `refund_${type}_${String(identifier).trim()}`;
}

/**
 * Processes pending refunds from orders and payments collections.
 * Uses atomic claim locks, bounded exponential backoff, and deterministic Stripe idempotency keys.
 */
async function processPendingRefunds(options = {}) {
  const maxBatch = options.maxBatch || 10;
  const maxRetries = options.maxRetries || 3;
  const baseDelayMs = options.baseDelayMs || 30000;
  const now = new Date();
  const lockTimeoutMs = 5 * 60 * 1000; // 5 minute claim lock
  const staleClaimThreshold = new Date(now.getTime() - lockTimeoutMs);

  const { ordersCollection, paymentsCollection, disputesCollection } = getCollections();
  const stripe = getStripeInstance();

  if (!stripe || (!ordersCollection && !paymentsCollection)) {
    return { processed: 0, refunded: 0, failed: 0, message: "Dependencies not ready" };
  }

  let processedCount = 0;
  let refundedCount = 0;
  let failedCount = 0;
  const errors = [];

  // 1. Process candidate orders
  if (ordersCollection) {
    try {
      const candidateOrders = await ordersCollection
        .find({
          paymentStatus: "paid",
          refundStatus: { $ne: "refunded" },
          $and: [
            {
              $or: [
                { refundQueue: true },
                { refundStatus: "pending_refund" },
                { orderStatus: "cancelled" },
                { orderStatus: "rejected" },
              ],
            },
            {
              $or: [
                { refundAttempts: { $exists: false } },
                { refundAttempts: null },
                { refundAttempts: { $lt: maxRetries } },
              ],
            },
            {
              $or: [
                { nextRetryAt: { $exists: false } },
                { nextRetryAt: null },
                { nextRetryAt: { $lte: now } },
              ],
            },
            {
              $or: [
                { refundStatus: { $exists: false } },
                { refundStatus: null },
                { refundStatus: { $ne: "failed_max_retries" } },
              ],
            },
          ],
        })
        .limit(maxBatch)
        .toArray();

      for (const order of candidateOrders) {
        if (order.refundStatus === "refunded") continue;
        if (order.refundStatus === "failed_max_retries") continue;
        if ((order.refundAttempts || 0) >= maxRetries) continue;
        if (order.nextRetryAt && new Date(order.nextRetryAt) > now) continue;

        // Atomic claim
        const claimFilter = {
          _id: order._id,
          refundStatus: { $ne: "refunded" },
          $or: [
            { refundClaimedAt: { $exists: false } },
            { refundClaimedAt: null },
            { refundClaimedAt: { $lt: staleClaimThreshold } },
          ],
        };

        const claimRes = await ordersCollection.updateOne(claimFilter, {
          $set: { refundClaimedAt: now },
          $inc: { refundAttempts: 1 },
        });

        if (!claimRes || claimRes.matchedCount === 0) {
          // Claimed by another worker
          continue;
        }

        processedCount++;

        // Determine payment intent ID
        let paymentIntentId = order.transactionId;
        if ((!paymentIntentId || !paymentIntentId.startsWith("pi_")) && paymentsCollection) {
          const paymentDoc = await paymentsCollection.findOne({
            $or: [
              { orderId: order._id },
              { session_id: order.paymentId },
            ],
          });
          if (paymentDoc && paymentDoc.transactionId && paymentDoc.transactionId.startsWith("pi_")) {
            paymentIntentId = paymentDoc.transactionId;
          }
        }

        if (!paymentIntentId || typeof paymentIntentId !== "string" || !paymentIntentId.startsWith("pi_")) {
          // Cannot execute refund without valid Stripe PaymentIntent
          const currentAttempts = (order.refundAttempts || 0) + 1;
          const isMax = currentAttempts >= maxRetries;
          await ordersCollection.updateOne(
            { _id: order._id },
            {
              $set: {
                refundError: "Missing or invalid Stripe PaymentIntent identifier",
                refundStatus: isMax ? "failed_max_retries" : (order.refundStatus || "pending_refund"),
                refundQueue: !isMax,
                updatedAt: new Date(),
              },
              $unset: { refundClaimedAt: "" },
            }
          );
          failedCount++;
          continue;
        }

        const isDisputedOrder = Boolean(order.isDisputed || order.disputeResolution === "resolved_buyer" || order.disputeId);
        const idempotencyKey = getRefundIdempotencyKey(
          order._id,
          isDisputedOrder ? "dispute_refund" : "order_cancel"
        );

        try {
          const refund = await stripe.refunds.create(
            {
              payment_intent: paymentIntentId,
              reason: order.orderStatus === "rejected" ? "duplicate" : "requested_by_customer",
            },
            { idempotencyKey }
          );

          if (refund && (refund.status === "succeeded" || refund.status === "pending")) {
            const isSucceeded = refund.status === "succeeded";
            const finalStatus = isSucceeded ? "refunded" : "pending_refund";
            const nowTime = new Date();

            const orderUpdate = {
              refundStatus: finalStatus,
              refundId: refund.id,
              refundQueue: !isSucceeded,
              updatedAt: nowTime,
            };

            const orderUnset = {
              refundClaimedAt: "",
              refundError: "",
            };

            if (isSucceeded) {
              orderUpdate.refundSuccessAt = order.refundSuccessAt || nowTime;
              orderUnset.nextRetryAt = "";
            } else {
              // Pending refund: do NOT assign refundSuccessAt
              const currentAttempts = (order.refundAttempts || 0) + 1;
              const delayMs = calculateBackoffDelay(currentAttempts, baseDelayMs);
              orderUpdate.nextRetryAt = new Date(nowTime.getTime() + delayMs);
            }

            await ordersCollection.updateOne(
              { _id: order._id },
              {
                $set: orderUpdate,
                $unset: orderUnset,
              }
            );

            if (paymentsCollection) {
              const paymentUpdate = {
                refundStatus: finalStatus,
                refundId: refund.id,
                refundQueue: !isSucceeded,
                updatedAt: nowTime,
              };
              const paymentUnset = {
                refundClaimedAt: "",
                refundError: "",
              };
              if (isSucceeded) {
                paymentUpdate.refundSuccessAt = order.refundSuccessAt || nowTime;
                paymentUnset.nextRetryAt = "";
              } else {
                paymentUpdate.nextRetryAt = orderUpdate.nextRetryAt;
              }

              await paymentsCollection.updateOne(
                { $or: [{ orderId: order._id }, { session_id: order.paymentId }] },
                {
                  $set: paymentUpdate,
                  $unset: paymentUnset,
                }
              );
            }

            if (disputesCollection && isDisputedOrder) {
              const disputeUpdate = {
                refundStatus: finalStatus,
                refundId: refund.id,
                updatedAt: nowTime,
              };
              if (isSucceeded) {
                disputeUpdate.refundSuccessAt = order.refundSuccessAt || nowTime;
              }
              await disputesCollection.updateOne(
                {
                  $or: [
                    { orderId: String(order._id) },
                    ...(ObjectId.isValid(order._id) ? [{ orderObjectId: new ObjectId(order._id) }] : []),
                  ],
                },
                {
                  $set: disputeUpdate,
                }
              );
            }

            if (isSucceeded) refundedCount++;
          }
        } catch (err) {
          const attempts = (order.refundAttempts || 0) + 1;
          const isMaxRetries = attempts >= maxRetries;
          const delayMs = calculateBackoffDelay(attempts, baseDelayMs);
          const nextRetryAt = new Date(now.getTime() + delayMs);

          const errUpdate = {
            refundError: err.message || String(err),
            refundStatus: isMaxRetries ? "failed_max_retries" : "pending_refund",
            refundQueue: !isMaxRetries,
            updatedAt: new Date(),
          };
          const errUnset = { refundClaimedAt: "" };

          if (!isMaxRetries) {
            errUpdate.nextRetryAt = nextRetryAt;
          } else {
            errUnset.nextRetryAt = "";
          }

          await ordersCollection.updateOne(
            { _id: order._id },
            {
              $set: errUpdate,
              $unset: errUnset,
            }
          );
          failedCount++;
          errors.push({ orderId: order._id, error: err.message });
        }
      }
    } catch (orderScanErr) {
      console.error("Error scanning pending order refunds:", orderScanErr.message);
    }
  }

  // 2. Process candidate payments (e.g. double-sale failed refunds)
  if (paymentsCollection) {
    try {
      const candidatePayments = await paymentsCollection
        .find({
          refundQueue: true,
          refundStatus: { $ne: "refunded" },
          $and: [
            {
              $or: [
                { refundAttempts: { $exists: false } },
                { refundAttempts: null },
                { refundAttempts: { $lt: maxRetries } },
              ],
            },
            {
              $or: [
                { nextRetryAt: { $exists: false } },
                { nextRetryAt: null },
                { nextRetryAt: { $lte: now } },
              ],
            },
            {
              $or: [
                { refundStatus: { $exists: false } },
                { refundStatus: null },
                { refundStatus: { $ne: "failed_max_retries" } },
              ],
            },
          ],
        })
        .limit(maxBatch)
        .toArray();

      for (const payment of candidatePayments) {
        if (payment.refundStatus === "refunded") continue;
        if (payment.refundStatus === "failed_max_retries") continue;
        if ((payment.refundAttempts || 0) >= maxRetries) continue;
        if (payment.nextRetryAt && new Date(payment.nextRetryAt) > now) continue;

        // Atomic claim
        const claimRes = await paymentsCollection.updateOne(
          {
            _id: payment._id,
            refundStatus: { $ne: "refunded" },
            $or: [
              { refundClaimedAt: { $exists: false } },
              { refundClaimedAt: null },
              { refundClaimedAt: { $lt: staleClaimThreshold } },
            ],
          },
          {
            $set: { refundClaimedAt: now },
            $inc: { refundAttempts: 1 },
          }
        );

        if (!claimRes || claimRes.matchedCount === 0) continue;

        processedCount++;

        const paymentIntentId = payment.transactionId;
        if (!paymentIntentId || !paymentIntentId.startsWith("pi_")) {
          const currentAttempts = (payment.refundAttempts || 0) + 1;
          const isMax = currentAttempts >= maxRetries;
          await paymentsCollection.updateOne(
            { _id: payment._id },
            {
              $set: {
                refundError: "Missing valid PaymentIntent ID",
                refundStatus: isMax ? "failed_max_retries" : (payment.refundStatus || "pending_refund"),
                refundQueue: !isMax,
                updatedAt: new Date(),
              },
              $unset: { refundClaimedAt: "" },
            }
          );
          failedCount++;
          continue;
        }

        const idempotencyKey = getRefundIdempotencyKey(
          payment.session_id || payment._id,
          "duplicate"
        );

        try {
          const refund = await stripe.refunds.create(
            {
              payment_intent: paymentIntentId,
              reason: "duplicate",
            },
            { idempotencyKey }
          );

          if (refund && (refund.status === "succeeded" || refund.status === "pending")) {
            const isSucceeded = refund.status === "succeeded";
            const finalStatus = isSucceeded ? "refunded" : "pending_refund";
            const nowTime = new Date();

            const paymentUpdate = {
              refundStatus: finalStatus,
              refundId: refund.id,
              refundQueue: !isSucceeded,
              updatedAt: nowTime,
            };
            const paymentUnset = {
              refundClaimedAt: "",
              refundError: "",
            };

            if (isSucceeded) {
              paymentUpdate.refundSuccessAt = payment.refundSuccessAt || nowTime;
              paymentUnset.nextRetryAt = "";
            } else {
              // Pending refund: NEVER set refundSuccessAt
              const currentAttempts = (payment.refundAttempts || 0) + 1;
              const delayMs = calculateBackoffDelay(currentAttempts, baseDelayMs);
              paymentUpdate.nextRetryAt = new Date(nowTime.getTime() + delayMs);
            }

            await paymentsCollection.updateOne(
              { _id: payment._id },
              {
                $set: paymentUpdate,
                $unset: paymentUnset,
              }
            );
            if (isSucceeded) refundedCount++;
          }
        } catch (err) {
          const attempts = (payment.refundAttempts || 0) + 1;
          const isMaxRetries = attempts >= maxRetries;
          const delayMs = calculateBackoffDelay(attempts, baseDelayMs);
          const nextRetryAt = new Date(now.getTime() + delayMs);

          const errUpdate = {
            refundError: err.message || String(err),
            refundStatus: isMaxRetries ? "failed_max_retries" : "pending_refund",
            refundQueue: !isMaxRetries,
            updatedAt: new Date(),
          };
          const errUnset = { refundClaimedAt: "" };

          if (!isMaxRetries) {
            errUpdate.nextRetryAt = nextRetryAt;
          } else {
            errUnset.nextRetryAt = "";
          }

          await paymentsCollection.updateOne(
            { _id: payment._id },
            {
              $set: errUpdate,
              $unset: errUnset,
            }
          );
          failedCount++;
          errors.push({ paymentId: payment._id, error: err.message });
        }
      }
    } catch (paymentScanErr) {
      console.error("Error scanning pending payment refunds:", paymentScanErr.message);
    }
  }

  return {
    processed: processedCount,
    refunded: refundedCount,
    failed: failedCount,
    errors,
  };
}

/**
 * Starts periodic background refund recovery worker.
 */
function startRefundRecoveryWorker(intervalMs = 300000) {
  if (recoveryTimer) return recoveryTimer;

  // Run initial pass after brief 5s warm-up
  const initialTimeout = setTimeout(() => {
    processPendingRefunds().catch((err) =>
      console.warn("Initial refund recovery pass warning:", err.message)
    );
  }, 5000);
  if (initialTimeout.unref) initialTimeout.unref();

  recoveryTimer = setInterval(() => {
    processPendingRefunds().catch((err) =>
      console.warn("Periodic refund recovery pass warning:", err.message)
    );
  }, intervalMs);

  if (recoveryTimer.unref) recoveryTimer.unref();
  return recoveryTimer;
}

/**
 * Stops periodic background refund recovery worker.
 */
function stopRefundRecoveryWorker() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

module.exports = {
  processPendingRefunds,
  startRefundRecoveryWorker,
  stopRefundRecoveryWorker,
  getRefundIdempotencyKey,
  calculateBackoffDelay,
};
