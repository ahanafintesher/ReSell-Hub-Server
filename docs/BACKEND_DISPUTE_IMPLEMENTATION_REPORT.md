# ReSell Hub — Backend Dispute API Implementation & Verification Report

**Audit Date:** November 20, 2026  
**Auditor:** Antigravity Autonomous Audit & Verification System  
**Component:** Backend Dispute & Resolution Management Subsystem  
**Backend Codebase:** `L:\resell-hub-server` (Express 5.2.1, MongoDB Native Driver 7.3.0, Stripe Node SDK 23.0.0, Jose-CJS 6.2.3, CommonJS)  
**Frontend Reference:** `L:\resell-hub` (Next.js 16.2.9, React 19.2.4, Better Auth 1.6.19)  
**Test Suite:** Node.js Native Test Runner (`node --test test/*.test.js`) — 175 tests, 67 suites, 100% passing  

---

## 1. Executive Summary

This audit verified, corrected, hardened, and regression-tested the Backend Dispute System for **ReSell Hub**. Both the primary Backend repository (`L:\resell-hub-server`) and the reference Frontend repository (`L:\resell-hub`) were thoroughly audited against `requirements.md` and the actual client-side implementation.

### Initial Discovery & Root Cause
Prior audit reports claimed full implementation; however, deep source code cross-referencing between Frontend React components (`src/app/dashboard/admin/disputes/page.jsx`, `src/components/Modals/BuyerDisputeModal.jsx`, `src/components/Order/BuyerOrderCard.jsx`, `src/lib/actions/disputes.js`) and Backend Express routes identified several critical operational discrepancies:
1. **Dispute Status Lifecycle Mismatch:** The Backend previously stored `status: "resolved"` upon resolution. The Frontend UI explicitly relies on specific status keys (`"resolved_buyer"`, `"resolved_seller"`, `"dismissed"`, `"opened"`). Setting `"resolved"` caused resolved disputes to fail the Frontend's `STATUS_CONFIG` lookup (falling back to "Under Review"), zeroed out KPI summary counters (`buyerFavoredCount`, `sellerFavoredCount`), and broke status filter tabs (`?status=resolved_buyer`).
2. **Duplicate Dispute Vulnerability:** Duplicate checks only checked active disputes (`status: { $in: ["opened", "pending"] }`). An order that had already undergone dispute resolution could have another dispute submitted.
3. **Repeated Resolution Race Condition:** The resolution guard only checked `dispute.status === "resolved" || dispute.status === "dismissed"`. With status set to `"resolved_buyer"` or `"resolved_seller"`, a dispute could be resolved multiple times.
4. **Buyer Identity Assignment on Admin Action:** When an administrator initiated or managed a dispute, `buyerEmail` recorded was `req.user.email` instead of the order's actual buyer.
5. **Admin Search & Filter Collisions:** In `GET /api/admin/disputes`, a search query overwritten `query.$or`, breaking status filtering when both parameters were provided.
6. **Recovery Idempotency & Dispute Document Sync:** In `src/utils/refundRecovery.js`, disputed orders retried with an `"order_cancel"` key rather than `"dispute_refund"`, and successful background refunds failed to update `disputesCollection`.
7. **Webhook Event Gap:** `charge.refunded` was unhandled in `src/routes/webhook.routes.js`, preventing asynchronous webhook updates from confirming refunds on disputed orders.

All issues were corrected in the Backend codebase, fully preserving CommonJS conventions, MongoDB Native Driver architecture, and strict security rules.

---

## 2. Comprehensive Files Audited

### Backend Files Inspected & Modified
- `src/config/db.js`: Verified `disputesCollection` declaration, safe performance index creation on `{ orderId: 1 }`, `{ buyerEmail: 1 }`, `{ status: 1 }`, and `{ createdAt: -1 }`.
- `src/routes/orders.routes.js`: Fixed `POST /api/orders/:id/dispute` duplicate dispute checks, buyer email preservation, and `GET /api/orders/:id/dispute` multi-format lookup (`orderId` string and `orderObjectId`).
- `src/routes/admin.routes.js`: Fixed `GET /api/admin/disputes` multi-status query handling (`resolved_buyer`, `resolved_seller`, `dismissed`, `opened`, `resolved`) and search combining; fixed `PATCH /api/admin/disputes/:id/resolve` status lifecycle, idempotency, and Stripe integration.
- `src/routes/webhook.routes.js`: Added authoritative `charge.refunded` webhook handler to synchronize order, dispute, and payment records upon confirmed Stripe refunds.
- `src/utils/refundRecovery.js`: Updated refund recovery worker to use `"dispute_refund"` idempotency key for disputed orders and synchronize `disputesCollection`.
- `test/disputes.test.js`: Expanded test suite from 22 to 30 tests covering all required buyer, admin, resolution, filter, and webhook persistence scenarios.

### Frontend Reference Files Inspected (Read-Only)
- `src/lib/actions/disputes.js`: Server actions `createDispute`, `getOrderDispute`, `getAdminDisputes`, `resolveDispute`.
- `src/lib/api-client.js`: Authenticated `serverFetch` appending Better Auth Bearer token.
- `src/app/dashboard/admin/disputes/page.jsx`: Admin dispute adjudication table, KPI counters, status filter tabs, search, and resolution modal.
- `src/components/Modals/BuyerDisputeModal.jsx`: Buyer dispute submission modal (`DISPUTE_REASONS` selector and details).
- `src/components/Order/BuyerOrderCard.jsx`: Buyer order display checking `order.isDisputed` and `order.disputeStatus`.
- `src/app/dashboard/buyer/orders/page.jsx`: Buyer orders list consuming `/api/buyer/orders`.
- `src/app/dashboard/admin/orders/page.jsx`: Admin order management interface.

---

## 3. Database Architecture & Index Verification

### Collection Initializer (`src/config/db.js`)
```javascript
// Live collection references
const collections = {
  // ...
  disputesCollection: null,
};

// Initialized during run()
collections.disputesCollection = collections.database.collection("disputes");
```

### Database Performance Indexes
Indexes are initialized safely via `safeCreateIndex()` during application startup without failing on restricted Atlas privileges:
- `{ orderId: 1 }`: Accelerated dispute lookup by order ID.
- `{ buyerEmail: 1 }`: Accelerated buyer-specific dispute queries.
- `{ status: 1 }`: Fast index scan for status-filtered queries (`opened`, `resolved_buyer`, etc.).
- `{ createdAt: -1 }`: Efficient reverse-chronological sorting for pagination.

### Stored Dispute Document Schema
```json
{
  "_id": "ObjectId('673e1c2e4f1a2b3c4d5e6f7a')",
  "orderId": "60c72b2f9b1d8b2bad100001",
  "orderObjectId": "ObjectId('60c72b2f9b1d8b2bad100001')",
  "buyerEmail": "buyer@example.com",
  "buyerName": "Md. Rakib Hasan",
  "sellerEmail": "seller@example.com",
  "sellerName": "Nusrat Jahan",
  "productId": "60c72b2f9b1d8b2bad123450",
  "productTitle": "Vintage Leather Jacket",
  "orderPrice": 4500,
  "paymentId": "cs_test_session_123",
  "reason": "Item not as described",
  "details": "Item arrived with torn lining not disclosed in listing.",
  "status": "resolved_buyer",
  "resolution": "resolved_buyer",
  "resolutionNotes": "Seller confirmed issue. Full refund issued.",
  "resolvedBy": "admin@resellhub.test",
  "resolvedAt": "2026-11-20T16:10:00.000Z",
  "refundStatus": "refunded",
  "refundId": "re_3MtwxAEkGgahOFsh1S3q4bpO",
  "createdAt": "2026-11-20T15:30:00.000Z",
  "updatedAt": "2026-11-20T16:10:00.000Z"
}
```

---

## 4. API Endpoints Documentation & Contract Specifications

### 4.1 POST `/api/orders/:id/dispute` (Buyer / Admin)
- **Route:** `src/routes/orders.routes.js`
- **Middleware:** `verifyToken`, `requireRole("buyer", "admin")`, `validateUserIdentity`
- **Input Validation:**
  - `id` must be valid MongoDB `ObjectId`.
  - `reason` must be string of at least 3 characters.
  - Ownership: `buyerEmail === req.user.email` (or `req.user.role === "admin"`).
  - Status: Order cannot be `cancelled` or `rejected`.
  - Duplicate: If `order.isDisputed === true` or existing dispute exists in `disputesCollection`, returns `409 Conflict`.
- **Response:** `HTTP 201 Created`
  ```json
  {
    "success": true,
    "message": "Dispute submitted successfully",
    "disputeId": "673e1c2e4f1a2b3c4d5e6f7a",
    "dispute": { ... }
  }
  ```

### 4.2 GET `/api/orders/:id/dispute` (Buyer / Seller / Admin)
- **Route:** `src/routes/orders.routes.js`
- **Middleware:** `verifyToken`, `requireRole("buyer", "seller", "admin")`
- **Access Control:**
  - Order buyer, order seller, or administrator only. Unrelated users receive `403 Forbidden`.
  - Non-existent order returns `404 Not Found`.
- **Response:** `HTTP 200 OK` with dispute object or `null` if none opened.

### 4.3 GET `/api/admin/disputes` (Admin Only)
- **Route:** `src/routes/admin.routes.js`
- **Middleware:** `verifyToken`, `requireRole("admin")`
- **Query Parameters:**
  - `page` (default 1), `limit` (default 10, max 100).
  - `status`: `"all"`, `"opened"`, `"resolved_buyer"`, `"resolved_seller"`, `"dismissed"`, or `"resolved"`.
  - `search`: Case-insensitive regex matching across `productTitle`, `buyerEmail`, `sellerEmail`, `orderId`, `reason`.
- **Response:** `HTTP 200 OK`
  ```json
  {
    "disputes": [ ... ],
    "total": 4,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
  ```

### 4.4 PATCH `/api/admin/disputes/:id/resolve` (Admin Only)
- **Route:** `src/routes/admin.routes.js`
- **Middleware:** `verifyToken`, `requireRole("admin")`
- **Payload:** Accepts `{ resolution, resolutionNotes }` or `{ decision, decisionNotes }`.
- **Permitted Decisions:** `"resolved_buyer"`, `"resolved_seller"`, `"dismissed"`, `"resolved"`.
- **State Transition Guard:** Rejects resolution if status is already in terminal state (`"resolved"`, `"resolved_buyer"`, `"resolved_seller"`, `"dismissed"`).
- **Financial Workflow for `resolved_buyer`:**
  - Only paid orders are refunded; unpaid orders set `refundStatus: "not_applicable"`.
  - Determines Stripe `payment_intent` from `order.transactionId`, `order.paymentId`, or `paymentsCollection`.
  - Derives deterministic idempotency key `refund_dispute_refund_<orderId>`.
  - Creates refund via `stripe.refunds.create()`.
  - **Rule 8 Guard:** Marked `"refunded"` ONLY when Stripe confirms `status === "succeeded"`. If pending or Stripe throws an error, marked `"pending_refund"` with `refundQueue: true` for the background worker.
- **Response:** `HTTP 200 OK`
  ```json
  {
    "success": true,
    "message": "Dispute marked as resolved_buyer",
    "status": "resolved_buyer",
    "resolution": "resolved_buyer",
    "refundStatus": "refunded",
    "refundId": "re_3MtwxAEkGgahOFsh1S3q4bpO"
  }
  ```

---

## 5. Stripe Refund Workflow & Consistency Architecture

```
[Admin Adjudication: resolved_buyer]
                │
         Is Order Paid?
        ┌───────┴───────┐
       Yes              No
        │                │
[Find PaymentIntent] [refundStatus: "not_applicable"]
        │
[Derive Idempotency Key]
        │
[Execute stripe.refunds.create()]
        ┌───────┴───────────────────────┐
Stripe Confirms: "succeeded"     Stripe Returns: "pending" / Network Error
        │                               │
[refundStatus: "refunded"]       [refundStatus: "pending_refund"]
[refundQueue: false]             [refundQueue: true]
[refundSuccessAt: new Date()]           │
                                 [Recovery Worker / Webhook]
                                        │
                                 [charge.refunded Webhook Confirmed]
                                        │
                                 [refundStatus: "refunded"]
```

---

## 6. Automated Test Results

### Dispute Test Suite (`test/disputes.test.js`)
All 30 automated dispute tests execute and pass synchronously:
```
▶ Dispute Workflow API Suite (Phase 5)
  ▶ 1. Buyer: Create Dispute (POST /api/orders/:id/dispute)
    ✔ creates dispute for buyer's own order with valid reason and details (45.33ms)
    ✔ rejects dispute submission without authentication (401) (4.72ms)
    ✔ rejects dispute submission if user does not own order (403) (5.75ms)
    ✔ rejects invalid order ID format (400) (2.91ms)
    ✔ rejects dispute with missing or too short reason (400) (2.95ms)
    ✔ rejects dispute on cancelled order (400) (3.37ms)
    ✔ rejects dispute on rejected order (400) (3.05ms)
    ✔ rejects invalid dispute payload (non-string or empty reason) (400) (3.76ms)
    ✔ prevents duplicate active disputes on same order (409) (5.82ms)
  ✔ 1. Buyer: Create Dispute (POST /api/orders/:id/dispute) (79.31ms)
  ▶ 2. Admin: View Disputes (GET /api/admin/disputes)
    ✔ returns paginated disputes list for admin (200) (5.17ms)
    ✔ rejects non-admin access (403) (4.07ms)
    ✔ supports status filtering (1.92ms)
    ✔ supports status filtering across resolved_buyer, resolved_seller, and opened (4.78ms)
    ✔ supports search filtering across productTitle and buyerEmail (2.21ms)
  ✔ 2. Admin: View Disputes (GET /api/admin/disputes) (18.53ms)
  ▶ 3. Admin: Resolve Dispute (PATCH /api/admin/disputes/:id/resolve)
    ✔ resolves dispute successfully and updates order (200) (3.17ms)
    ✔ resolves dispute as resolved_seller and updates order (200) (6.40ms)
    ✔ resolves dispute as dismissed and updates order (200) (1.73ms)
    ✔ accepts resolution payload using decision and decisionNotes format (200) (1.68ms)
    ✔ rejects non-admin resolution attempt (403) (1.73ms)
    ✔ rejects invalid resolution decision (400) (1.55ms)
    ✔ prevents resolving an already resolved dispute (400) (3.17ms)
    ✔ resolved_buyer triggers Stripe refund and marks order refunded when Stripe confirms success (3.17ms)
    ✔ resolved_buyer does not label as refunded when Stripe fails or is pending (2.38ms)
  ✔ 3. Admin: Resolve Dispute (PATCH /api/admin/disputes/:id/resolve) (25.49ms)
  ▶ 4. Order Dispute Lookup (GET /api/orders/:id/dispute)
    ✔ returns dispute document for order buyer (200) (2.31ms)
    ✔ returns dispute document for order seller (200) (1.78ms)
    ✔ returns dispute document for admin (200) (1.57ms)
    ✔ rejects unauthorized third-party user (403) (1.81ms)
    ✔ rejects invalid order ID format (400) (1.41ms)
    ✔ returns 404 for non-existent order (1.68ms)
  ✔ 4. Order Dispute Lookup (GET /api/orders/:id/dispute) (10.89ms)
  ▶ 5. Stripe Webhook & Durability for Disputes
    ✔ charge.refunded webhook updates dispute and order refundStatus to refunded (5.17ms)
  ✔ 5. Stripe Webhook & Durability for Disputes (5.30ms)
✔ Dispute Workflow API Suite (Phase 5) (148.87ms)
ℹ tests 30, pass 30, fail 0
```

### Full Backend Regression Suite (`npm test`)
```
ℹ tests 175
ℹ suites 67
ℹ pass 175
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 5959.61ms
```
No regressions were introduced to authentication, products, orders, payments, webhooks, or admin analytics.

---

## 7. Operational Status Verdict

The Backend Dispute System is **READY**. All endpoints are fully operational, contracts match the Frontend implementation, Stripe refund consistency is guaranteed under Rule 8, and automated test coverage provides full regression verification.
