const express = require("express");
const { getCollections } = require("../config/db");
const { verifyToken, requireRole } = require("../middleware/auth");
const { extractEmail } = require("../utils/helpers");

const router = express.Router();

// ──────────────────────────────────────────
// I. SELLER ANALYTICS
// ──────────────────────────────────────────

/**
 * GET /api/seller/analytics
 * Returns authentic seller analytics:
 * - Total sales and revenue (excluding unpaid, cancelled, and rejected orders)
 * - Monthly sales & revenue trends
 * - Top 5 products by completed sales
 * - Order fulfillment status distribution
 * - Inventory breakdown (available vs sold)
 */
router.get(
  "/api/seller/analytics",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      const { ordersCollection, productsCollection } = getCollections();
      if (!ordersCollection || !productsCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const sellerEmail =
        req.user.role === "admin" && req.query.sellerInfo
          ? req.query.sellerInfo.trim()
          : req.user.email;

      // 1. Fetch seller orders directly from database
      const sellerFilter = {
        $or: [{ sellerInfo: sellerEmail }, { "sellerInfo.email": sellerEmail }],
      };
      const sellerOrders = await ordersCollection.find(sellerFilter).toArray();

      // 2. Fetch seller products directly from database
      const sellerProducts = await productsCollection.find(sellerFilter).toArray();

      // 3. Compute Inventory
      const inventory = {
        total: sellerProducts.length,
        available: 0,
        sold: 0,
      };

      sellerProducts.forEach((p) => {
        const st = (p.status || "available").toLowerCase();
        if (st === "sold") inventory.sold++;
        else inventory.available++;
      });

      // 4. Compute Fulfillment Distribution & Sales
      const fulfillmentDistribution = {
        pending: 0,
        accepted: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
        rejected: 0,
      };

      let totalSales = 0;
      let totalRevenue = 0;
      let pendingOrders = 0;

      const monthlyTrendMap = {};
      const productSalesMap = {};

      sellerOrders.forEach((o) => {
        const st = (o.orderStatus || "pending").toLowerCase();
        if (fulfillmentDistribution[st] !== undefined) {
          fulfillmentDistribution[st]++;
        }

        if (st === "pending") {
          pendingOrders++;
        }

        // Only count towards earned revenue if order was paid and not cancelled/rejected
        const isPaid = o.paymentStatus === "paid";
        const isValidOrder = st !== "cancelled" && st !== "rejected";

        if (isPaid && isValidOrder) {
          totalSales++;
          const price = Number(o.price) || 0;
          totalRevenue += price;

          // Monthly trends
          const d = o.createdAt ? new Date(o.createdAt) : new Date();
          const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          if (!monthlyTrendMap[monthKey]) {
            monthlyTrendMap[monthKey] = { month: monthKey, sales: 0, revenue: 0 };
          }
          monthlyTrendMap[monthKey].sales++;
          monthlyTrendMap[monthKey].revenue += price;

          // Product sales tracking
          const pid = o.productId || o.productTitle || "Unknown";
          if (!productSalesMap[pid]) {
            productSalesMap[pid] = {
              productId: pid,
              title: o.productTitle || "Untitled Product",
              salesCount: 0,
              totalRevenue: 0,
            };
          }
          productSalesMap[pid].salesCount++;
          productSalesMap[pid].totalRevenue += price;
        }
      });

      const monthlySales = Object.values(monthlyTrendMap).sort((a, b) =>
        a.month.localeCompare(b.month)
      );

      const topProducts = Object.values(productSalesMap)
        .sort((a, b) => b.salesCount - a.salesCount || b.totalRevenue - a.totalRevenue)
        .slice(0, 5);

      res.status(200).json({
        sellerEmail,
        totalSales,
        totalRevenue,
        pendingOrders,
        inventory,
        monthlySales,
        topProducts,
        fulfillmentDistribution,
      });
    } catch (error) {
      console.error("Seller analytics error:", error.message || error);
      res.status(500).json({ message: "Failed to generate seller analytics" });
    }
  }
);

module.exports = router;
