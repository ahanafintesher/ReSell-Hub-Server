const express = require("express");
const { getCollections } = require("../config/db");
const { extractEmail, sanitizeSellerPublicInfo } = require("../utils/helpers");

const router = express.Router();

/**
 * Helper to count documents safely across both real MongoDB collections and mock collections
 */
async function countDocs(collection, filter = {}) {
  if (!collection) return 0;
  if (typeof collection.countDocuments === "function") {
    return await collection.countDocuments(filter);
  }
  const docs = await collection.find(filter).toArray();
  return docs.length;
}

// ──────────────────────────────────────────
// PUBLIC MARKETPLACE STATISTICS
// ──────────────────────────────────────────

/**
 * GET /api/public/stats
 * Public endpoint returning aggregate platform figures for homepage showcase.
 * Excludes blocked users and defines clearly which statuses count.
 */
router.get("/api/public/stats", async (req, res) => {
  try {
    const { productsCollection, usersCollection, ordersCollection } =
      getCollections();

    if (!productsCollection || !usersCollection || !ordersCollection) {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database not connected" });
    }

    // 1. Total Products (available / active products)
    const totalProducts = await countDocs(productsCollection, {
      status: { $ne: "rejected" },
    });

    // 2. Total Active Sellers
    const totalSellers = await countDocs(usersCollection, {
      role: "seller",
      status: "active",
    });

    // 3. Total Active Buyers
    const totalBuyers = await countDocs(usersCollection, {
      role: "buyer",
      status: "active",
    });

    // 4. Completed Orders (delivered or verified paid orders)
    const completedOrders = await countDocs(ordersCollection, {
      $or: [{ orderStatus: "delivered" }, { paymentStatus: "paid" }],
    });

    res.status(200).json({
      totalProducts,
      totalSellers,
      totalBuyers,
      completedOrders,
    });
  } catch (error) {
    console.error("Public stats error:", error.message || error);
    res.status(500).json({ message: "Failed to fetch marketplace statistics" });
  }
});

// ──────────────────────────────────────────
// PUBLIC SELLER SHOWCASE & PROFILES
// ──────────────────────────────────────────

/**
 * GET /api/sellers/top-rated
 * Returns top-rated sellers showcase based on reviews and completed sales.
 * Never exposes private phone, addresses, or internal credentials.
 */
router.get("/api/sellers/top-rated", async (req, res) => {
  try {
    const { usersCollection, productsCollection, ordersCollection, reviewsCollection } =
      getCollections();

    if (!usersCollection) {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database not connected" });
    }

    const sellers = await usersCollection
      .find({ role: "seller", status: "active" })
      .toArray();

    const sellerProfiles = await Promise.all(
      sellers.map(async (seller) => {
        const sellerEmail = seller.email;

        // Count completed sales
        let completedSales = 0;
        if (ordersCollection) {
          const orders = await ordersCollection
            .find({
              $or: [{ sellerInfo: sellerEmail }, { "sellerInfo.email": sellerEmail }],
              paymentStatus: "paid",
            })
            .toArray();
          completedSales = orders.length;
        }

        // Count active listings
        let activeListings = 0;
        if (productsCollection) {
          const products = await productsCollection
            .find({
              $or: [{ sellerInfo: sellerEmail }, { "sellerInfo.email": sellerEmail }],
              status: { $nin: ["sold", "rejected"] },
              moderationStatus: { $ne: "rejected" },
            })
            .toArray();
          activeListings = products.length;
        }

        // Compute average review rating across seller's products
        let rating = 5.0;
        let reviewCount = 0;
        if (reviewsCollection && productsCollection) {
          const sellerProducts = await productsCollection
            .find({
              $or: [{ sellerInfo: sellerEmail }, { "sellerInfo.email": sellerEmail }],
            })
            .toArray();
          const prodIds = sellerProducts.map((p) => String(p._id));

          if (prodIds.length > 0) {
            const reviews = await reviewsCollection.find({}).toArray();
            const relevantReviews = reviews.filter((r) => {
              const pid = r.productId || r.review?.productId;
              return pid && prodIds.includes(String(pid));
            });

            if (relevantReviews.length > 0) {
              reviewCount = relevantReviews.length;
              const sum = relevantReviews.reduce(
                (acc, r) => acc + (r.rating || r.review?.rating || 5),
                0
              );
              rating = Number((sum / reviewCount).toFixed(1));
            }
          }
        }

        return {
          id: seller._id,
          name: seller.name || "Seller",
          sellerEmail: seller.email,
          image: seller.image || seller.photo || null,
          isVerified: Boolean(seller.isVerified),
          rating,
          reviewCount,
          completedSales,
          activeListings,
          createdAt: seller.createdAt || null,
        };
      })
    );

    // Sort by rating desc, then completed sales desc
    sellerProfiles.sort((a, b) => b.rating - a.rating || b.completedSales - a.completedSales);

    // Return top 10 sellers
    res.status(200).json(sellerProfiles.slice(0, 10));
  } catch (error) {
    console.error("Top rated sellers error:", error.message || error);
    res.status(500).json({ message: "Failed to fetch top-rated sellers" });
  }
});

/**
 * GET /api/sellers/:sellerEmail
 * Returns public seller profile and their active inventory.
 */
router.get("/api/sellers/:sellerEmail", async (req, res) => {
  try {
    const { sellerEmail } = req.params;
    if (!sellerEmail || !sellerEmail.includes("@")) {
      return res.status(400).json({ message: "Valid seller email is required" });
    }

    const { usersCollection, productsCollection, ordersCollection, reviewsCollection } =
      getCollections();

    if (!usersCollection) {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database not connected" });
    }

    const seller = await usersCollection.findOne({
      email: sellerEmail.trim(),
      role: "seller",
    });

    if (!seller || seller.status === "blocked") {
      return res.status(404).json({ message: "Seller not found or inactive" });
    }

    // Active listings
    let activeProducts = [];
    if (productsCollection) {
      const rawProducts = await productsCollection
        .find({
          $or: [{ sellerInfo: seller.email }, { "sellerInfo.email": seller.email }],
          status: { $nin: ["sold", "rejected"] },
          moderationStatus: { $ne: "rejected" },
        })
        .toArray();
      activeProducts = rawProducts.map((p) => ({
        ...p,
        sellerInfo: sanitizeSellerPublicInfo(p.sellerInfo),
      }));
    }

    // Completed sales
    let completedSales = 0;
    if (ordersCollection) {
      const orders = await ordersCollection
        .find({
          $or: [{ sellerInfo: seller.email }, { "sellerInfo.email": seller.email }],
          paymentStatus: "paid",
        })
        .toArray();
      completedSales = orders.length;
    }

    // Reviews summary
    let rating = 5.0;
    let reviewCount = 0;
    if (reviewsCollection && productsCollection) {
      const allSellerProducts = await productsCollection
        .find({
          $or: [{ sellerInfo: seller.email }, { "sellerInfo.email": seller.email }],
        })
        .toArray();
      const prodIds = allSellerProducts.map((p) => String(p._id));

      if (prodIds.length > 0) {
        const reviews = await reviewsCollection.find({}).toArray();
        const relevantReviews = reviews.filter((r) => {
          const pid = r.productId || r.review?.productId;
          return pid && prodIds.includes(String(pid));
        });

        if (relevantReviews.length > 0) {
          reviewCount = relevantReviews.length;
          const sum = relevantReviews.reduce(
            (acc, r) => acc + (r.rating || r.review?.rating || 5),
            0
          );
          rating = Number((sum / reviewCount).toFixed(1));
        }
      }
    }

    // Sanitize output - never expose phone, internal tokens, or credentials
    res.status(200).json({
      name: seller.name || "Seller",
      sellerEmail: seller.email,
      image: seller.image || seller.photo || null,
      isVerified: Boolean(seller.isVerified),
      rating,
      reviewCount,
      completedSales,
      totalListings: activeProducts.length,
      listings: activeProducts,
      createdAt: seller.createdAt || null,
    });
  } catch (error) {
    console.error("Seller profile error:", error.message || error);
    res.status(500).json({ message: "Failed to fetch seller profile" });
  }
});

module.exports = router;
