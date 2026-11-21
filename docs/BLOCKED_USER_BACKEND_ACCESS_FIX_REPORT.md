# ReSell Hub Backend — Blocked User Access Protection Audit & Fix Report

**Date:** November 21, 2026  
**Repository:** ReSell-Hub-Server  
**Target Environment:** Node.js CommonJS (Express 5.2.1, MongoDB Native Driver 7.3.0, jose-cjs 6.2.3)  
**Overall Status:** ALL VERIFICATIONS PASSED (257 / 257 Tests Passing across 86 Test Suites)

---

## 1. Executive Summary

An audit of the ReSell Hub backend user blocking mechanism was conducted to ensure that accounts marked with `status: "blocked"` by an administrator cannot access protected APIs or bypass restrictions using valid or unexpired JSON Web Tokens (JWTs).

### Key Findings & Fixes
1. **Audit of `src/middleware/auth.js` (`verifyToken` & `requireRole`)**:
   - `verifyToken` queried the user's MongoDB record on each authenticated request, correctly rejecting blocked users.
   - However, the response payload was previously `{ message: "Forbidden: Account is blocked" }`, missing `success: false` and `code: "ACCOUNT_BLOCKED"`.
   - **Fix Applied:** Updated `verifyToken` and `requireRole` to return HTTP 403 with the exact required schema:
     ```json
     {
       "success": false,
       "message": "Your account has been blocked by an administrator.",
       "code": "ACCOUNT_BLOCKED"
     }
     ```

2. **Audit of Product Details & Public Endpoints (`optionalVerifyToken`)**:
   - Routes utilizing `optionalVerifyToken` (`GET /api/products/:id` and `GET /api/products`) previously set `req.user = null` if `dbUser.status === "blocked"` and called `next()`.
   - **Vulnerability Identified:** Blocked authenticated users were silently treated as anonymous visitors, allowing them to browse products and product details despite holding a blocked authenticated identity.
   - **Fix Applied:** In `optionalVerifyToken`, if an authenticated token is provided and resolves to a MongoDB user with `status: "blocked"`, the request is immediately rejected with HTTP 403 `ACCOUNT_BLOCKED`.
   - **Public Browsing Preserved:** Requests without an `Authorization` header (or with unauthenticated/malformed tokens) continue to receive anonymous public browsing access (`req.user = null`).

3. **Protection Against Old Valid JWTs**:
   - Because `verifyToken` and `optionalVerifyToken` query MongoDB authoritatively on every authenticated request, a JWT issued prior to an administrator blocking an account cannot bypass the restriction. The next incoming request immediately detects `status: "blocked"` and returns HTTP 403.

4. **Role Integrity & Re-enabling Access**:
   - The Admin status update endpoint `PATCH /api/admin/users/:id/status` modifies only the `status` and `updatedAt` fields in MongoDB, preserving the existing user `role` (e.g., `"seller"`, `"buyer"`, `"admin"`).
   - When an administrator unblocks an account (`status: "active"`), access is immediately restored according to their existing role permissions.

---

## 2. Requirements Compliance Matrix

| Requirement | Description | Status | Evidence / Implementation |
|---|---|---|---|
| **REQ-1** | Inspect existing admin user-blocking API and `src/middleware/auth.js` | **PASS** | Inspected `PATCH /api/admin/users/:id/status` and `src/middleware/auth.js`. |
| **REQ-2** | Verify `verifyToken` checks MongoDB user status on every authenticated request | **PASS** | Verified in `src/middleware/auth.js`: lines 74–95 execute `usersCollection.findOne()` on each request and verify `dbUser.status`. |
| **REQ-3** | Return HTTP 403 with `success: false`, `message: "Your account has been blocked by an administrator."`, `code: "ACCOUNT_BLOCKED"` | **PASS** | Standardized `BLOCKED_ACCOUNT_RESPONSE` across `verifyToken`, `optionalVerifyToken`, and `requireRole`. |
| **REQ-4** | Verify all protected Buyer, Seller, and Admin API routes use appropriate auth middleware | **PASS** | Audited all 11 route files. All protected routes employ `verifyToken` and `requireRole` guards. |
| **REQ-5** | Inspect Product Details API (`optionalVerifyToken`): blocked users receive 403; public browsing preserved | **PASS** | Fixed `optionalVerifyToken` in `src/middleware/auth.js` to return HTTP 403 for blocked authenticated callers while preserving public anonymous access. |
| **REQ-6** | Ensure old valid JWTs cannot bypass a newly applied block | **PASS** | Authoritative MongoDB query prevents token status caching across requests; immediately blocks old valid JWTs. |
| **REQ-7** | Preserve existing block/unblock API and user roles | **PASS** | Admin `PATCH /api/admin/users/:id/status` preserved intact; updates `status` without altering `role`. |
| **REQ-8** | When user is unblocked, restore access according to existing role | **PASS** | Re-activating status to `"active"` restores role-based access immediately without token re-issuance. |
| **REQ-9** | No new authentication system, collections, session stores, or dependencies | **PASS** | Pure middleware hardening within existing architecture; 0 new npm packages or database collections. |
| **REQ-10** | Do not modify frontend repository | **PASS** | All changes confined strictly to `resell-hub-server`. |

---

## 3. Code Modifications

### 3.1 `src/middleware/auth.js`
- Introduced frozen constant `BLOCKED_ACCOUNT_RESPONSE`:
  ```javascript
  const BLOCKED_ACCOUNT_RESPONSE = Object.freeze({
    success: false,
    message: "Your account has been blocked by an administrator.",
    code: "ACCOUNT_BLOCKED",
  });
  ```
- **`verifyToken` (Line 94):**
  ```javascript
  // Reject blocked accounts on every authenticated route
  if (dbUser.status === "blocked") {
    return res.status(403).json(BLOCKED_ACCOUNT_RESPONSE);
  }
  ```
- **`optionalVerifyToken` (Line 176):**
  ```javascript
  // Reject blocked accounts even on optional auth routes (do not silently treat as anonymous)
  if (dbUser && dbUser.status === "blocked") {
    return res.status(403).json(BLOCKED_ACCOUNT_RESPONSE);
  }
  ```
- **`requireRole` (Line 252):**
  ```javascript
  // Reject blocked accounts
  if (dbUser && dbUser.status === "blocked") {
    return res.status(403).json(BLOCKED_ACCOUNT_RESPONSE);
  }
  ```
- Exported `BLOCKED_ACCOUNT_RESPONSE` for module consumers and test harnesses.

### 3.2 `index.js`
- Exported `BLOCKED_ACCOUNT_RESPONSE` from the main application entry point.

### 3.3 `test/security.test.js`
- Updated assertion in Section 4 ("Blocked Accounts") to validate `success: false`, `code: "ACCOUNT_BLOCKED"`, and `message: "Your account has been blocked by an administrator."`.

### 3.4 `test/blocked-user-access.test.js` (New Test Suite)
- Created dedicated test suite with 20 comprehensive test cases covering:
  - Active user access to protected APIs.
  - Blocked user 403 rejection across `verifyToken` and `requireRole` routes.
  - Old JWT block invalidation.
  - Product Details API blocking with authenticated tokens.
  - Preserved anonymous visitor browsing on public products.
  - Unblocking and permission restoration according to existing role.
  - Existing Admin block/unblock endpoint functionality and authorization guards.

---

## 4. Protected Surface Route Audit Summary

All domain routes were inspected to ensure complete protection against unauthorized or blocked user access:

| Route File | Endpoint | Method | Middleware Stack | Blocked User Behavior |
|---|---|---|---|---|
| `admin.routes.js` | `/api/admin/users` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/users/:id` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/users/:id/status` | PATCH | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/users/:id` | DELETE | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/orders` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/products/:id/status` | PATCH | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/users/:id/verify` | PATCH | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/reports` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/reports/:id` | PATCH | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/stats` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/analytics` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/refunds/process-queue` | POST | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/disputes` | GET | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `admin.routes.js` | `/api/admin/disputes/:id/resolve` | PATCH | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders` | POST | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/seller/orders` | GET | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/buyer/orders` | GET | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders/:orderId/status` | PATCH | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders/:orderId` | DELETE | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders/:orderId` | GET | `verifyToken` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders/:orderId/cancel` | PATCH | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders/:id/dispute` | POST | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `orders.routes.js` | `/api/orders/:id/dispute` | GET | `verifyToken`, `requireRole("buyer", "seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `payments.routes.js` | `/api/payments` | POST | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `payments.routes.js` | `/api/payments` | GET | `verifyToken`, `requireRole("buyer", "seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `payments.routes.js` | `/api/create-checkout-session` | POST | `verifyToken`, `requireRole("buyer", "seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `products.routes.js` | `/api/products` | POST | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `products.routes.js` | `/api/my-products` | GET | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `products.routes.js` | `/api/products` | GET | `optionalVerifyToken` | 403 if authenticated token is blocked; 200 for anonymous |
| `products.routes.js` | `/api/products/:id` | GET | `optionalVerifyToken` | 403 if authenticated token is blocked; 200 for anonymous |
| `products.routes.js` | `/api/products/:id/report` | POST | `verifyToken` | 403 `ACCOUNT_BLOCKED` |
| `products.routes.js` | `/api/products/:id` | PATCH | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `products.routes.js` | `/api/products/:id/moderate` | PATCH | `verifyToken`, `requireRole("admin")` | 403 `ACCOUNT_BLOCKED` |
| `products.routes.js` | `/api/products/:id` | DELETE | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `reviews.routes.js` | `/api/reviews` | POST | `verifyToken` | 403 `ACCOUNT_BLOCKED` |
| `seller.routes.js` | `/api/seller/analytics` | GET | `verifyToken`, `requireRole("seller", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `users.routes.js` | `/api/users/profile` | GET | `verifyToken` | 403 `ACCOUNT_BLOCKED` |
| `users.routes.js` | `/api/users/profile` | PATCH | `verifyToken` | 403 `ACCOUNT_BLOCKED` |
| `wishlist.routes.js` | `/api/wishlist` | GET | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `wishlist.routes.js` | `/api/wishlist` | POST | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |
| `wishlist.routes.js` | `/api/wishlist/:id` | DELETE | `verifyToken`, `requireRole("buyer", "admin")` | 403 `ACCOUNT_BLOCKED` |

---

## 5. Verification & Test Execution Results

### 5.1 Dedicated Audit Suite (`test/blocked-user-access.test.js`)
Command: `node --test test/blocked-user-access.test.js`

```text
▶ Blocked User Access Protection Audit & Verification Suite
  ▶ 1. Active user can access protected APIs
    ✔ active buyer can access GET /api/buyer/orders (200) (30.747ms) [PASS]
    ✔ active seller can access GET /api/my-products (200) (4.302ms) [PASS]
    ✔ active user can access GET /api/users/profile (200) (4.074ms) [PASS]
  ✔ 1. Active user can access protected APIs (39.8245ms)
  ▶ 2. Blocked user receives HTTP 403 with exact error contract
    ✔ blocked user on verifyToken-only route (GET /api/users/profile) receives 403 ACCOUNT_BLOCKED (4.6506ms) [PASS]
    ✔ blocked user on requireRole route (GET /api/buyer/orders) receives 403 ACCOUNT_BLOCKED (5.5002ms) [PASS]
    ✔ blocked seller on POST /api/products receives 403 ACCOUNT_BLOCKED (15.9224ms) [PASS]
    ✔ blocked user on POST /api/reviews receives 403 ACCOUNT_BLOCKED (3.5423ms) [PASS]
    ✔ blocked buyer on GET /api/wishlist receives 403 ACCOUNT_BLOCKED (3.4479ms) [PASS]
  ✔ 2. Blocked user receives HTTP 403 with exact error contract (33.6823ms)
  ▶ 3. Old JWT cannot bypass blocking
    ✔ old valid JWT immediately fails with 403 when user is blocked in MongoDB (6.8607ms) [PASS]
  ✔ 3. Old JWT cannot bypass blocking (7.0245ms)
  ▶ 4. Blocked user cannot access Product Details API with an authenticated token
    ✔ GET /api/products/:id with blocked user token returns 403 ACCOUNT_BLOCKED (not anonymous fallback) (3.1366ms) [PASS]
    ✔ GET /api/products with blocked user token returns 403 ACCOUNT_BLOCKED (1.9106ms) [PASS]
  ✔ 4. Blocked user cannot access Product Details API with an authenticated token (5.2123ms)
  ▶ 5. Anonymous visitors can still browse public products
    ✔ anonymous visitor without Authorization header can view product details (200) (2.2833ms) [PASS]
    ✔ anonymous visitor without Authorization header can browse public product list (200) (1.5991ms) [PASS]
    ✔ anonymous visitor cannot view pending product on GET /api/products/:id (404) (1.2952ms) [PASS]
    ✔ visitor with invalid/malformed token is safely handled as anonymous on GET /api/products/:id (200) (1.5798ms) [PASS]
  ✔ 5. Anonymous visitors can still browse public products (7.0131ms)
  ▶ 6. Unblocking restores permitted API access according to existing role
    ✔ unblocking a user restores API access and preserves existing role permissions (10.5723ms) [PASS]
  ✔ 6. Unblocking restores permitted API access according to existing role (10.7125ms)
  ▶ 7. Existing Admin block/unblock functionality still works
    ✔ Admin can block an active user via PATCH /api/admin/users/:id/status (2.5187ms) [PASS]
    ✔ Admin can unblock a user via PATCH /api/admin/users/:id/status (2.3249ms) [PASS]
    ✔ rejects invalid status values with 400 (2.281ms) [PASS]
    ✔ non-admin user cannot call PATCH /api/admin/users/:id/status (403) (2.9259ms) [PASS]
  ✔ 7. Existing Admin block/unblock functionality still works (10.3334ms)
✔ Blocked User Access Protection Audit & Verification Suite (118.8134ms)
ℹ tests 20
ℹ suites 8
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### 5.2 Complete Test Suite Execution Results
Command: `npm test` (`node --test test/*.test.js`)

| Test File | Test Count | Pass | Fail | Blocked | Status |
|---|---|---|---|---|---|
| `adversarial-production-readiness.test.js` | 20 | 20 | 0 | 0 | **PASS** |
| `blocked-user-access.test.js` | 20 | 20 | 0 | 0 | **PASS** |
| `categories.test.js` | 13 | 13 | 0 | 0 | **PASS** |
| `disputes.test.js` | 18 | 18 | 0 | 0 | **PASS** |
| `index-initialization.test.js` | 12 | 12 | 0 | 0 | **PASS** |
| `moderation-security.test.js` | 12 | 12 | 0 | 0 | **PASS** |
| `reliability-audit.test.js` | 24 | 24 | 0 | 0 | **PASS** |
| `reliability-fixes-regression.test.js` | 37 | 37 | 0 | 0 | **PASS** |
| `requirements-features.test.js` | 45 | 45 | 0 | 0 | **PASS** |
| `security.test.js` | 42 | 42 | 0 | 0 | **PASS** |
| `stripe-webhook.test.js` | 14 | 14 | 0 | 0 | **PASS** |
| **TOTAL** | **257** | **257** | **0** | **0** | **PASS** |

All 257 tests passed with zero failures, zero skipped, and zero regressions.

---

## 6. Conclusion

The blocked-user access restriction has been audited, strengthened, and verified across all backend routes. Blocked accounts can no longer access protected endpoints or view product details via authenticated tokens, while public anonymous browsing remains fully operational.
