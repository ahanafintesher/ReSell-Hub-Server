# ReSell Hub Backend — Public Product Listing Fix for Blocked Users Report

**Date:** November 21, 2026  
**Repository:** ReSell-Hub-Server  
**Target Environment:** Node.js CommonJS (Express 5.2.1, MongoDB Native Driver 7.3.0, jose-cjs 6.2.3)  
**Overall Status:** ALL CHECKS PASSED (260 / 260 Tests Passing across 86 Test Suites)

---

## 1. Executive Summary

Following the implementation of blocked-user access protection, an issue was identified where blocked users received HTTP 403 `ACCOUNT_BLOCKED` when accessing the public product catalog (`GET /api/products`). This occurred because the user's browser sent an existing/cached Authorization token to the product listing endpoint, causing `optionalVerifyToken` to reject the request and the frontend to display:
> *"Unable to load products — Failed to fetch products"*

### Access Policy Alignment

| Endpoint / Surface | Blocked User Policy | Implemented State |
|---|---|---|
| **Public product listing (`GET /api/products`)** | **ALLOW** | **PASS** — Returns 200 with approved public products even when an Authorization token for a blocked user is present. |
| **Product Details (`GET /api/products/:id`)** | **BLOCK** | **PASS** — Rejects blocked authenticated users with HTTP 403 `ACCOUNT_BLOCKED`. |
| **Protected dashboard APIs** | **BLOCK** | **PASS** — Rejects blocked accounts on `verifyToken` and `requireRole` with HTTP 403 `ACCOUNT_BLOCKED`. |
| **Orders, payments, wishlist, profile, reviews** | **BLOCK** | **PASS** — Rejects blocked accounts with HTTP 403 `ACCOUNT_BLOCKED`. |

---

## 2. Technical Implementation

### 2.1 Problem Analysis
`GET /api/products` and `GET /api/products/:id` both previously shared `optionalVerifyToken`. When `optionalVerifyToken` was configured to reject blocked accounts with HTTP 403 `ACCOUNT_BLOCKED`, any request carrying a token from a blocked user to either endpoint was rejected with 403. While this is the desired behavior for Product Details (`GET /api/products/:id`), it broke public catalog browsing on `GET /api/products`.

### 2.2 Fix Applied
1. **Configurable Optional Auth in `src/middleware/auth.js`:**
   - Introduced `createOptionalVerifyToken(options)`:
     - `optionalVerifyToken` (`blockBlockedUsers: true`): Used on sensitive optional-auth routes such as Product Details (`GET /api/products/:id`). Rejects blocked accounts with HTTP 403 `ACCOUNT_BLOCKED`.
     - `publicOptionalVerifyToken` (`blockBlockedUsers: false`): Used on purely public browsing routes such as Public Product Listing (`GET /api/products`). If a token belongs to a blocked account, it treats the request as anonymous (`req.user = null`) and continues via `next()` without returning 403.
2. **Applied `publicOptionalVerifyToken` to `GET /api/products` in `src/routes/products.routes.js`:**
   - The route remains genuinely public.
   - Active users and anonymous visitors can browse public products.
   - Blocked users sending an old/existing Bearer token can browse public, approved products with HTTP 200.
   - Blocked users cannot gain admin moderation powers: `req.user` remains `null`, preventing access to pending or rejected listings.
   - Private seller information remains strictly sanitized via `sanitizeSellerPublicInfo`.
   - Existing filters (category, price, condition), search, sorting, and pagination are 100% preserved.
3. **Preserved `optionalVerifyToken` on `GET /api/products/:id`:**
   - Blocked authenticated callers to Product Details receive HTTP 403 `ACCOUNT_BLOCKED`.
   - Anonymous visitors without an `Authorization` header can view approved product details.
4. **Preserved `verifyToken` and `requireRole` Across All Protected Routes:**
   - Orders, payments, wishlist, user profile, reviews, and admin routes continue to reject blocked users with HTTP 403 `ACCOUNT_BLOCKED`.

---

## 3. Requirements Verification Matrix

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| **REQ-1** | Inspect `src/middleware/auth.js` and `src/routes/products.routes.js` | **PASS** | Inspected and identified shared `optionalVerifyToken` collision. |
| **REQ-2** | Keep existing `verifyToken` blocking behavior unchanged | **PASS** | `verifyToken` and `requireRole` continue to reject blocked users with 403 `ACCOUNT_BLOCKED`. |
| **REQ-3** | Keep blocked-user protection on `GET /api/products/:id` | **PASS** | `GET /api/products/:id` uses `optionalVerifyToken` and returns 403 `ACCOUNT_BLOCKED` for blocked users. |
| **REQ-4** | Modify only the public product listing authentication behavior | **PASS** | Updated `GET /api/products` to use `publicOptionalVerifyToken`. |
| **REQ-5** | Ensure `GET /api/products` returns public approved products with old Authorization token | **PASS** | Blocked user presenting Bearer token receives HTTP 200 with approved listings. |
| **REQ-6** | Do not expose private user info or restricted product data | **PASS** | `sanitizeSellerPublicInfo` remains enforced; pending/rejected items remain hidden. |
| **REQ-7** | Preserve existing filters, search, pagination, sorting, and response structure | **PASS** | Tested category filter, title search, price sorting, and paginated response structure. |
| **REQ-8** | Treat listing endpoint as genuinely public without unnecessary auth logic | **PASS** | `publicOptionalVerifyToken` gracefully falls back to `req.user = null` for non-admin/blocked users. |
| **REQ-9** | Do not weaken blocked-user protection on any protected endpoint | **PASS** | All 260 existing and regression security tests pass without weakening guards. |
| **REQ-10** | Do not modify the frontend repository | **PASS** | Confined strictly to backend repository `resell-hub-server`. |

---

## 4. Test Execution Results

### 4.1 Dedicated Audit Suite (`test/blocked-user-access.test.js`)
Command: `node --test test/blocked-user-access.test.js`

```text
▶ Blocked User Access Protection Audit & Verification Suite
  ▶ 1. Active user can access protected APIs
    ✔ active buyer can access GET /api/buyer/orders (200) [PASS]
    ✔ active seller can access GET /api/my-products (200) [PASS]
    ✔ active user can access GET /api/users/profile (200) [PASS]
  ✔ 1. Active user can access protected APIs (51.0793ms)
  ▶ 2. Blocked user receives HTTP 403 with exact error contract
    ✔ blocked user on verifyToken-only route (GET /api/users/profile) receives 403 ACCOUNT_BLOCKED [PASS]
    ✔ blocked user on requireRole route (GET /api/buyer/orders) receives 403 ACCOUNT_BLOCKED [PASS]
    ✔ blocked seller on POST /api/products receives 403 ACCOUNT_BLOCKED [PASS]
    ✔ blocked user on POST /api/reviews receives 403 ACCOUNT_BLOCKED [PASS]
    ✔ blocked buyer on GET /api/wishlist receives 403 ACCOUNT_BLOCKED [PASS]
  ✔ 2. Blocked user receives HTTP 403 with exact error contract (42.1352ms)
  ▶ 3. Old JWT cannot bypass blocking
    ✔ old valid JWT immediately fails with 403 when user is blocked in MongoDB [PASS]
  ✔ 3. Old JWT cannot bypass blocking (6.8292ms)
  ▶ 4. Public Product Listing ALLOW vs Product Details BLOCK for Blocked Users
    ✔ GET /api/products/:id with blocked user token returns 403 ACCOUNT_BLOCKED (strictly blocked from product details) [PASS]
    ✔ GET /api/products with blocked user token returns 200 (ALLOW public product browsing) [PASS]
    ✔ GET /api/products preserves filtering, search, and pagination for blocked users [PASS]
    ✔ GET /api/products with blocked admin token does not leak pending products (treated as anonymous public view) [PASS]
    ✔ GET /api/products with active admin token can query ?status=pending [PASS]
  ✔ 4. Public Product Listing ALLOW vs Product Details BLOCK for Blocked Users (15.6313ms)
  ▶ 5. Anonymous visitors can still browse public products
    ✔ anonymous visitor without Authorization header can view product details (200) [PASS]
    ✔ anonymous visitor without Authorization header can browse public product list (200) [PASS]
    ✔ anonymous visitor cannot view pending product on GET /api/products/:id (404) [PASS]
    ✔ visitor with invalid/malformed token is safely handled as anonymous on GET /api/products/:id (200) [PASS]
  ✔ 5. Anonymous visitors can still browse public products (11.1323ms)
  ▶ 6. Unblocking restores permitted API access according to existing role
    ✔ unblocking a user restores API access and preserves existing role permissions [PASS]
  ✔ 6. Unblocking restores permitted API access according to existing role (7.2609ms)
  ▶ 7. Existing Admin block/unblock functionality still works
    ✔ Admin can block an active user via PATCH /api/admin/users/:id/status [PASS]
    ✔ Admin can unblock a user via PATCH /api/admin/users/:id/status [PASS]
    ✔ rejects invalid status values with 400 [PASS]
    ✔ non-admin user cannot call PATCH /api/admin/users/:id/status (403) [PASS]
  ✔ 7. Existing Admin block/unblock functionality still works (13.5984ms)
✔ Blocked User Access Protection Audit & Verification Suite (152.9386ms)
ℹ tests 23
ℹ suites 8
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### 4.2 Full Backend Regression Suite (`npm test`)
Command: `npm test` (`node --test test/*.test.js`)

| Test Suite | Total Tests | Pass | Fail | Status |
|---|---|---|---|---|
| `adversarial-production-readiness.test.js` | 20 | 20 | 0 | **PASS** |
| `blocked-user-access.test.js` | 23 | 23 | 0 | **PASS** |
| `categories.test.js` | 13 | 13 | 0 | **PASS** |
| `disputes.test.js` | 18 | 18 | 0 | **PASS** |
| `index-initialization.test.js` | 12 | 12 | 0 | **PASS** |
| `moderation-security.test.js` | 12 | 12 | 0 | **PASS** |
| `reliability-audit.test.js` | 24 | 24 | 0 | **PASS** |
| `reliability-fixes-regression.test.js` | 37 | 37 | 0 | **PASS** |
| `requirements-features.test.js` | 45 | 45 | 0 | **PASS** |
| `security.test.js` | 42 | 42 | 0 | **PASS** |
| `stripe-webhook.test.js` | 14 | 14 | 0 | **PASS** |
| **TOTAL** | **260** | **260** | **0** | **ALL PASS** |

---

## 5. Conclusion

The public product listing endpoint (`GET /api/products`) now allows public product browsing for all users—including blocked users whose browsers send cached Authorization tokens—resolving the frontend "Unable to load products" error. Meanwhile, Product Details (`GET /api/products/:id`) and all protected dashboard/action endpoints remain strictly secured with HTTP 403 `ACCOUNT_BLOCKED` for blocked accounts.
