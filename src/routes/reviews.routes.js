const express = require("express");
const { getCollections } = require("../config/db");
const { verifyToken, validateUserIdentity } = require("../middleware/auth");

const router = express.Router();

// ──────────────────────────────────────────
// REVIEWS API
// ──────────────────────────────────────────

// Post review (Authenticated)
router.post("/api/reviews", verifyToken, async (req, res) => {
  try {
    if (!validateUserIdentity(req, res)) return;

    const review = req.body;
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      return res.status(400).send({ message: "Review data is required" });
    }

    const { reviewsCollection } = getCollections();
    if (!reviewsCollection) {
      return res
        .status(503)
        .send({ message: "Service Unavailable: Database not connected" });
    }

    // Rating validation if supplied
    const rating = review.rating ?? review.review?.rating;
    if (rating !== undefined) {
      const numRating = Number(rating);
      if (isNaN(numRating) || numRating < 1 || numRating > 5) {
        return res
          .status(400)
          .send({ message: "Review rating must be a number between 1 and 5" });
      }
    }

    if (req.user.role !== "admin") {
      review.userEmail = req.user.email;
      if (review.review && typeof review.review === "object") {
        review.review.userEmail = req.user.email;
      }
    }
    review.createdAt = new Date();

    const result = await reviewsCollection.insertOne(review);
    res.status(201).send(result);
  } catch (error) {
    console.error("Post review error:", error.message || error);
    res.status(500).send({ message: "Failed to post review" });
  }
});

// Get reviews by productId (Public)
router.get("/api/reviews", async (req, res) => {
  try {
    const { reviewsCollection } = getCollections();
    if (!reviewsCollection) {
      return res
        .status(503)
        .send({ message: "Service Unavailable: Database not connected" });
    }

    const productId = req.query.productId;
    const query = productId ? { "review.productId": productId } : {};
    const result = await reviewsCollection.find(query).toArray();
    res.send(result);
  } catch (error) {
    console.error("Get reviews error:", error.message || error);
    res.status(500).send({ message: "Failed to fetch reviews" });
  }
});

// Calculate average rating of a product (Public, supports both spellings)
const averageRatingHandler = async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) {
      return res
        .status(400)
        .send({ message: "productId query parameter is required" });
    }

    const { reviewsCollection } = getCollections();
    if (!reviewsCollection) {
      return res
        .status(503)
        .send({ message: "Service Unavailable: Database not connected" });
    }

    // Safe handling if aggregate is not implemented (e.g. basic mock collection)
    if (typeof reviewsCollection.aggregate !== "function") {
      const reviews = await reviewsCollection
        .find({ "review.productId": productId })
        .toArray();
      if (!reviews.length) {
        return res.send({ avarageRating: 0, averageRating: 0 });
      }
      const sum = reviews.reduce(
        (acc, r) => acc + (r.review?.rating || r.rating || 0),
        0
      );
      const avg = Number((sum / reviews.length).toFixed(1));
      return res.send({ avarageRating: avg, averageRating: avg });
    }

    const result = await reviewsCollection
      .aggregate([
        {
          $match: {
            "review.productId": productId,
          },
        },
        {
          $group: {
            _id: "$review.productId",
            avarageRating: { $avg: "$review.rating" },
          },
        },
      ])
      .toArray();

    if (result.length === 0) {
      return res.send({ avarageRating: 0, averageRating: 0 });
    }

    const avg = Number(result[0].avarageRating.toFixed(1));
    res.send({
      avarageRating: avg,
      averageRating: avg,
    });
  } catch (error) {
    console.error("Average rating error:", error.message || error);
    res.status(500).send({ message: "Failed to calculate average rating" });
  }
};

router.get("/api/reviews/avarage-rating", averageRatingHandler);
router.get("/api/reviews/average-rating", averageRatingHandler);

module.exports = router;
