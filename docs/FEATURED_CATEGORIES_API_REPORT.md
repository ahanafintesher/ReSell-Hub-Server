# Featured Categories API Route Implementation Report

**Date:** November 21, 2026  
**System:** ReSell Hub Backend (Express 5.2.1, MongoDB Native Driver 7.3.0, Node.js CommonJS)  
**Status:** ALL CHECKS PASSED (225 / 225 Tests Passing, 77 Suites)  

---

## 1. Executive Summary

This report documents the design, implementation, and automated testing of the new public featured categories API route (`GET /api/v1/featured`, with aliases `GET /api/featured` and `GET /featured`) for the ReSell Hub backend platform.

The endpoint fetches exactly 8 active featured categories directly from the existing MongoDB `categories` collection, enforcing a strict business priority sequence, excluding `Others` and unexpected categories, preserving all document fields (`_id`, `name`, `description`, `isActive`), and remaining completely decoupled from MongoDB insertion or natural document order.

---

## 2. Endpoint Specification & Route Architecture

### 2.1 Route Details
- **Primary Endpoint:** `GET /api/v1/featured`
- **Route Aliases Supported:** `GET /api/featured`, `GET /featured`
- **HTTP Method:** `GET`
- **Authentication & Authorization:** Public access (no JWT, bearer token, or role guard required)
- **Database Collection:** `categories` (bound via `getCollections().categoriesCollection` in `src/config/db.js`)
- **Route Handler Location:** `src/routes/categories.routes.js`
- **Application Pipeline Mount:** Mounted directly via `categoriesRoutes` in `index.js` (`app.use(categoriesRoutes)`)

### 2.2 Expected Custom Category Sequence
The 8 featured categories are ordered strictly according to the platform's custom priority map:

1. **Electronics** (Priority 1)
2. **Audio** (Priority 2)
3. **Wearables** (Priority 3)
4. **Accessories** (Priority 4)
5. **Fashion** (Priority 5)
6. **Furniture** (Priority 6)
7. **Vehicles** (Priority 7)
8. **Mobile Phones** (Priority 8)

> [!IMPORTANT]
> - **"Others" is strictly excluded** from the featured categories payload.
> - **Unknown / newly introduced categories are strictly excluded** from the featured categories payload.
> - **Inactive categories (`isActive: false`) are strictly excluded**.
> - **Alphabetical sorting is prohibited**: The response order is governed exclusively by the explicit priority map.
> - **Insertion order independence**: The sorting is deterministic in memory and independent of MongoDB physical storage or query return order.
> - **Limit of 8 applied after filtering and sorting**: If fewer than 8 eligible categories exist in the database, matching items are returned without crashing.

---

## 3. Implementation Details

### 3.1 Custom Priority Map
The priority mapping is shared with the existing category ordering infrastructure in `src/routes/categories.routes.js`:

```javascript
const PREDEFINED_CATEGORY_ORDER = [
  "Electronics",
  "Audio",
  "Wearables",
  "Accessories",
  "Fashion",
  "Furniture",
  "Vehicles",
  "Mobile Phones",
];

const CATEGORY_PRIORITY_MAP = new Map(
  PREDEFINED_CATEGORY_ORDER.map((name, index) => [name, index + 1])
);
```

### 3.2 Filtering & Sorting Logic (`getFeaturedCategories`)
The `getFeaturedCategories` function applies business filtering, deterministic priority sorting, and slicing:

```javascript
function getFeaturedCategories(categories, limit = 8) {
  if (!Array.isArray(categories)) return [];

  const eligible = categories.filter(
    (cat) => cat && cat.isActive === true && CATEGORY_PRIORITY_MAP.has(cat.name)
  );

  eligible.sort((a, b) => {
    return CATEGORY_PRIORITY_MAP.get(a.name) - CATEGORY_PRIORITY_MAP.get(b.name);
  });

  return eligible.slice(0, limit);
}
```

### 3.3 Route Handler & Database Query
The route handler leverages the MongoDB native driver with a lean projection and active status filtering:

```javascript
router.get(
  ["/api/v1/featured", "/api/featured", "/featured"],
  async (req, res) => {
    try {
      const { categoriesCollection } = getCollections();

      if (!categoriesCollection) {
        return res.status(503).json({
          success: false,
          message: "Service Unavailable: Database not connected",
        });
      }

      const categories = await categoriesCollection
        .find(
          {
            isActive: true,
            name: { $in: PREDEFINED_CATEGORY_ORDER },
          },
          { projection: { _id: 1, name: 1, description: 1, isActive: 1 } }
        )
        .toArray();

      const sanitizedCategories = categories.map((cat) => ({
        _id: cat._id,
        name: cat.name,
        description: cat.description,
        isActive: cat.isActive,
      }));

      const featuredCategories = getFeaturedCategories(sanitizedCategories, 8);

      res.status(200).json({
        success: true,
        message: "Featured categories fetched successfully",
        data: featuredCategories,
      });
    } catch (error) {
      console.error("Featured categories fetch error:", error.message || error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch featured categories",
      });
    }
  }
);
```

---

## 4. Response Structure

### 4.1 Successful Response (`HTTP 200 OK`)
```json
{
  "success": true,
  "message": "Featured categories fetched successfully",
  "data": [
    {
      "_id": "6b011c30c6c30b7882d37454",
      "name": "Electronics",
      "description": "Laptops, computers, displays, and consumer electronics tested and ready for use.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d37455",
      "name": "Audio",
      "description": "Noise-cancelling headphones, wireless earbuds, premium speakers, and hi-fi gear.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d37456",
      "name": "Wearables",
      "description": "Smartwatches, fitness bands, health sensors, and wearable smart accessories.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d37457",
      "name": "Accessories",
      "description": "Ergonomic keyboards, mice, docking stations, chargers, and workspace cables.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d37458",
      "name": "Fashion",
      "description": "Curated vintage apparel, jackets, shoes, designer streetwear, and everyday accessories.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d37459",
      "name": "Furniture",
      "description": "Solid wood work desks, ergonomic task chairs, lighting, and living spaces.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d3745a",
      "name": "Vehicles",
      "description": "Commuter bicycles, electric scooters, cycling helmets, and travel equipment.",
      "isActive": true
    },
    {
      "_id": "6b011c30c6c30b7882d3745b",
      "name": "Mobile Phones",
      "description": "Certified pre-owned smartphones, tablets, styluses, and protective cases.",
      "isActive": true
    }
  ]
}
```

### 4.2 Error Responses
- **Database Not Connected (`HTTP 503 Service Unavailable`):**
  ```json
  {
    "success": false,
    "message": "Service Unavailable: Database not connected"
  }
  ```
- **Database Query Fault (`HTTP 500 Internal Server Error`):**
  ```json
  {
    "success": false,
    "message": "Failed to fetch featured categories"
  }
  ```

---

## 5. Files Created or Modified

| File Path | Action | Description |
| :--- | :--- | :--- |
| `src/routes/categories.routes.js` | Modified | Added `getFeaturedCategories` helper and mounted `GET /api/v1/featured` (with `/api/featured` and `/featured` aliases). Preserved existing `/categories` route without modifications. Exported `getFeaturedCategories` for unit testing. |
| `test/categories.test.js` | Modified | Added 17 automated tests covering `GET /api/v1/featured` integration (HTTP 200, 8-element limit, custom sequence, "Others" exclusion, inactive filtering, unknown category omission, partial collection safety, database independence, schema sanitization, route aliases, unauthenticated access, 503/500 error guards) and unit test coverage for `getFeaturedCategories`. |
| `docs/FEATURED_CATEGORIES_API_REPORT.md` | Created | Comprehensive architectural report, endpoint specification, verification audit, and test results. |

---

## 6. Verification and Audit Matrix

| # | Verification Item | Target Scope | Observed Result | Status |
| :---: | :--- | :--- | :--- | :---: |
| 1 | **HTTP 200 & Status** | `GET /api/v1/featured` | Returns HTTP 200 with standard `{ success: true, message: ..., data: [...] }` | **PASS** |
| 2 | **Exact 8 Categories** | Data payload length | Contains exactly 8 items when all expected categories are active | **PASS** |
| 3 | **Exact Custom Ordering** | Category sequence | Exactly matches Electronics, Audio, Wearables, Accessories, Fashion, Furniture, Vehicles, Mobile Phones | **PASS** |
| 4 | **"Others" Excluded** | Category filtering | "Others" category is strictly omitted from the featured response | **PASS** |
| 5 | **Inactive Filtering** | Category filtering | Inactive categories (`isActive: false`) are excluded; remaining items retain relative order | **PASS** |
| 6 | **Unknown Categories Excluded** | Edge case handling | New or unmapped categories in DB do not appear in the featured response | **PASS** |
| 7 | **Fewer Than 8 Available** | Edge case handling | Returns available matching categories without crashing if DB has fewer than 8 items | **PASS** |
| 8 | **Empty Collection Safety** | Edge case handling | Returns empty array `data: []` without throwing an error | **PASS** |
| 9 | **Database Dynamic Data** | MongoDB integration | Data is fetched dynamically from MongoDB; custom IDs and descriptions are preserved | **PASS** |
| 10 | **Internal Field Sanitization** | Schema projection | Internal metadata (`__v`, cluster properties) are not exposed | **PASS** |
| 11 | **Insertion Order Independence** | Database storage layout | Predefined order is enforced even when DB documents are inserted in reverse | **PASS** |
| 12 | **Route Aliases** | API accessibility | `/api/featured` and `/featured` return the identical 8 featured categories | **PASS** |
| 13 | **Existing /categories Unchanged** | Regression protection | Existing `GET /api/v1/categories` continues to return all 9 categories (including "Others") | **PASS** |
| 14 | **Public Access (No Auth)** | Security & auth guards | Accessible without authorization headers, bearer tokens, or user cookies | **PASS** |
| 15 | **DB Connection Error Handling** | Error resilience | Returns HTTP 503 when `categoriesCollection` is uninitialized | **PASS** |
| 16 | **DB Query Fault Handling** | Error resilience | Returns HTTP 500 when database query throws | **PASS** |
| 17 | **Full Test Suite Regression** | Node.js native test suite | All 225 tests across 77 test suites passing (0 failures) | **PASS** |

---

## 7. Automated Test Execution Summary

The Node.js test runner executed the full test suite including the new featured categories integration and unit tests:

```text
▶ Categories Collection & Public API Test Suite
  ▶ 1. Category Seeding and Idempotency (4 tests) - PASS
  ▶ 2. Public Categories API Endpoint & Custom Sorting (9 tests) - PASS
  ▶ 3. Unit Tests: Sorting Helper & Priority Map (3 tests) - PASS
  ▶ 4. Featured Categories API Endpoint (GET /api/v1/featured) (14 tests) - PASS
  ▶ 5. Unit Tests: Featured Categories Filter & Sorter (3 tests) - PASS
✔ Categories Collection & Public API Test Suite (33 tests) - PASS

ℹ tests 225
ℹ suites 77
ℹ pass 225
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

---

## 8. Limitations and Blockers

- **Limitations:** None. The endpoint operates directly on the existing MongoDB `categories` collection and seamlessly handles varying numbers of active categories.
- **Blockers:** None. All tests pass without errors or warnings.
