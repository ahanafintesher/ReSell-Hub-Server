# ReSell Hub — Backend-Frontend API Compatibility Audit Report

**Date of Audit:** November 20, 2026  
**Auditor:** Antigravity Autonomous Audit & Verification System  
**Backend Codebase:** `L:\resell-hub-server` (Express 5.2.1, MongoDB Native Driver 7.3.0)  
**Frontend Reference:** `L:\resell-hub` (Next.js 16.2.9 Turbopack, React 19.2.4, Better Auth 1.6.19)  

---

## 1. Scope & Objective

This report details the exact contract alignment between the **Frontend React/Next.js application** and the **Backend Express server** for the Dispute & Resolution Management system. Every API endpoint, request body, query parameter, authentication header, response schema, and status code expected by the Frontend was audited against the Backend implementation.

---

## 2. API Endpoint & Contract Matrix

| Feature | Frontend Action / Component | Expected Endpoint & Method | Backend Implementation | Contract Status |
| :--- | :--- | :--- | :--- | :--- |
| **Open Dispute** | `createDispute()` in `src/lib/actions/disputes.js` / `BuyerDisputeModal.jsx` | `POST /api/orders/:id/dispute` | `src/routes/orders.routes.js:677` | **100% COMPATIBLE** |
| **Order Dispute Details** | `getOrderDispute()` in `src/lib/actions/disputes.js` | `GET /api/orders/:id/dispute` | `src/routes/orders.routes.js:793` | **100% COMPATIBLE** |
| **Admin List Disputes** | `getAdminDisputes()` in `src/lib/actions/disputes.js` / `AdminDisputesPage.jsx` | `GET /api/admin/disputes` | `src/routes/admin.routes.js:770` | **100% COMPATIBLE** |
| **Admin Resolve Dispute** | `resolveDispute()` in `src/lib/actions/disputes.js` / `AdminDisputesPage.jsx` | `PATCH /api/admin/disputes/:id/resolve` | `src/routes/admin.routes.js:828` | **100% COMPATIBLE** |
| **Buyer Orders View** | `getOrdersByBuyerInfo()` in `src/lib/actions/orders.js` / `BuyerOrderCard.jsx` | `GET /api/buyer/orders` | `src/routes/orders.routes.js:191` | **100% COMPATIBLE** |
| **Admin Orders View** | `getAdminOrders()` in `src/lib/actions/orders.js` / `AdminOrdersPage.jsx` | `GET /api/admin/orders` | `src/routes/admin.routes.js:211` | **100% COMPATIBLE** |

---

## 3. Deep Dive into Request & Response Payloads

### 3.1 POST `/api/orders/:id/dispute`
- **Frontend Caller:**
  ```javascript
  // L:\resell-hub\src\lib\actions\disputes.js
  export async function createDispute(orderId, { reason, details }) {
    const response = await serverFetch(`/api/orders/${orderId}/dispute`, {
      method: "POST",
      body: JSON.stringify({ reason, details }),
    });
    // ...
  }
  ```
- **Backend Handler:**
  - Extracts `{ reason, details } = req.body || {}`.
  - Verifies `reason` is a non-empty string $\ge 3$ characters.
  - Sanitizes `details` string.
- **Frontend Error Expectation:** `throw new Error(data.message || "Failed to submit dispute")`
- **Backend Error Response:** `{ message: "A valid dispute reason (at least 3 characters) is required" }` (HTTP 400).
- **Backend Success Response:**
  ```json
  {
    "success": true,
    "message": "Dispute submitted successfully",
    "disputeId": "673e1c2e4f1a2b3c4d5e6f7a",
    "dispute": { ... }
  }
  ```
- **Verdict:** Identical shape, exact field compatibility.

---

### 3.2 GET `/api/orders/:id/dispute`
- **Frontend Caller:**
  ```javascript
  // L:\resell-hub\src\lib\actions\disputes.js
  export async function getOrderDispute(orderId) {
    const response = await serverFetch(`/api/orders/${orderId}/dispute`, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  }
  ```
- **Backend Handler:**
  - Validates MongoDB `ObjectId`.
  - Enforces buyer/seller/admin authorization.
  - Looks up dispute by `{ $or: [{ orderId: id }, { orderObjectId: new ObjectId(id) }] }`.
  - Returns `dispute` object or `null` if none found.
- **Verdict:** Returns JSON dispute object or `null`, completely meeting Frontend expectations.

---

### 3.3 GET `/api/admin/disputes`
- **Frontend Caller:**
  ```javascript
  // L:\resell-hub\src\lib\actions\disputes.js
  export async function getAdminDisputes(params = {}) {
    const { page = 1, limit = 10, status = "all", search = "" } = params;
    // ...
    const response = await serverFetch(`/api/admin/disputes?${query.toString()}`);
    return await response.json();
  }
  ```
- **Frontend UI Consumer (`AdminDisputesPage.jsx`):**
  - Expects either `{ disputes: [...], total, totalPages, page, limit }` or an array `[...]`.
  - Filters by tab status: `"all"`, `"opened"`, `"resolved_buyer"`, `"resolved_seller"`, `"dismissed"`.
  - Performs search query: `?search=...`.
- **Backend Handler:**
  - Returns `{ disputes: [...], total, page, limit, totalPages }`.
  - Handles all Frontend filter tabs:
    - `"all"`: all records.
    - `"opened"`: matches `{ status: { $in: ["opened", "pending"] } }`.
    - `"resolved_buyer"`: matches `{ status: "resolved_buyer" }` and legacy `{ status: "resolved", resolution: "resolved_buyer" }`.
    - `"resolved_seller"`: matches `{ status: "resolved_seller" }` and legacy `{ status: "resolved", resolution: "resolved_seller" }`.
    - `"dismissed"`: matches `{ status: "dismissed" }`.
    - `"resolved"`: matches `{ status: { $in: ["resolved", "resolved_buyer", "resolved_seller"] } }`.
  - Safely joins status filtering with search keyword filtering via `$and`.
- **Verdict:** Fully compatible with Frontend pagination, filtering, and search behavior.

---

### 3.4 PATCH `/api/admin/disputes/:id/resolve`
- **Frontend Caller:**
  ```javascript
  // L:\resell-hub\src\lib\actions\disputes.js
  export async function resolveDispute(disputeId, payload = {}) {
    const resolution = payload.resolution || payload.decision;
    const resolutionNotes = payload.resolutionNotes || payload.decisionNotes || "";

    const response = await serverFetch(`/api/admin/disputes/${disputeId}/resolve`, {
      method: "PATCH",
      body: JSON.stringify({ resolution, resolutionNotes }),
    });
    return await response.json();
  }
  ```
- **Payload Flexibility:**
  - Accommodates both `{ resolution, resolutionNotes }` and `{ decision, decisionNotes }`.
- **Status Lifecycle Contract:**
  - Before Fix: Backend returned `status: "resolved"`, breaking Frontend's `STATUS_CONFIG` badge lookup, zeroing KPI counts, and breaking tab filters.
  - After Fix: Backend returns `status: "resolved_buyer"`, `"resolved_seller"`, or `"dismissed"` matching the Frontend's `STATUS_CONFIG` keys.
- **Backend Success Response:**
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
- **Verdict:** Exact contract match.

---

## 4. Authentication & Authorization Compatibility

1. **Token Transport:**
   - Frontend `serverFetch` (`src/lib/api-client.js`) retrieves the session JWT from Better Auth and attaches `Authorization: Bearer <token>`.
   - Backend `verifyToken` (`src/middleware/auth.js`) parses `Authorization: Bearer <token>` and verifies it using `jose-cjs` against `JWKS_URL` or `JWT_SECRET`.
2. **Server-Authoritative User Identity:**
   - Backend never trusts client-supplied user roles from headers or payload bodies.
   - `verifyToken` looks up the user in MongoDB `usersCollection` to extract authoritative email, name, role, and active status.
   - If user account status is `"blocked"`, Backend returns `403 Forbidden: Account is blocked`.
3. **Role Enforcement:**
   - Buyer dispute submission: Protected with `requireRole("buyer", "admin")`.
   - Admin dispute management: Protected with `requireRole("admin")`. Non-admins receive `403 Forbidden`.
   - Ownership guard: `buyerEmail === req.user.email` verified on Backend.

---

## 5. Dispute Status & UI Badge Compatibility

| Backend Stored Status (`dispute.status`) | Frontend Config Key (`STATUS_CONFIG`) | Frontend UI Display Label | Badge Styling |
| :--- | :--- | :--- | :--- |
| `"opened"` | `opened` | **Under Review** | Amber badge (`bg-amber-100`) |
| `"resolved_buyer"` | `resolved_buyer` | **Buyer Refunded** | Emerald badge (`bg-emerald-100`) |
| `"resolved_seller"` | `resolved_seller` | **Seller Favored** | Blue badge (`bg-blue-100`) |
| `"dismissed"` | `dismissed` | **Dismissed** | Slate badge (`bg-slate-100`) |

### Buyer Order Card Integration
In `L:\resell-hub\src\components\Order\BuyerOrderCard.jsx`:
```jsx
{order.isDisputed ? (
  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-100 text-amber-800 ...">
    <Scale className="w-3.5 h-3.5" />
    Disputed ({order.disputeStatus || "opened"})
  </span>
) : (
  order.orderStatus !== "cancelled" &&
  order.orderStatus !== "rejected" && (
    <BuyerDisputeModal order={order} />
  )
)}
```
When an order is disputed:
- Initial submission: `order.isDisputed: true`, `order.disputeStatus: "opened"` $\to$ displays `Disputed (opened)`.
- Upon resolution: `order.disputeStatus` updates to `"resolved_buyer"`, `"resolved_seller"`, or `"dismissed"` $\to$ displays `Disputed (resolved_buyer)`, etc.

---

## 6. Financial Reconciliation & Rule 8 Compatibility Note

The Frontend resolution modal displays "Refund Buyer", and the table badge displays "Buyer Refunded".
To ensure accounting and financial integrity:
- Backend **never marks an order as refunded prematurely**.
- When `resolution === "resolved_buyer"` is chosen, `refundStatus` is set to `"pending_refund"` while an immediate call is made to Stripe.
- If Stripe confirms `status === "succeeded"`, `refundStatus` transitions to `"refunded"`.
- If Stripe is pending or unavailable, `refundStatus` remains `"pending_refund"` with `refundQueue: true` for the background worker or incoming `charge.refunded` webhook.
- The Backend response provides both `status: "resolved_buyer"` (satisfying the Frontend UI) and `refundStatus: "pending_refund" | "refunded"` (preserving strict audit consistency).

---

## 7. Remaining Frontend Integration Tasks

**Zero remaining Frontend code modifications are required.** The Backend was fully adapted to the existing Frontend conventions and contracts. All Frontend routes, server actions, modals, and tables work directly with the updated Backend endpoints without any client-side changes.
