const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const app = express();
const port = process.env.PORT
const uri = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const database = client.db("resell_hub");
    const productsCollection = database.collection("products");
    const reviewsCollection = database.collection("reviews");
    const wishlistCollection = database.collection("wishlist");
    const paymentsCollection = database.collection("payments");
    const ordersCollection = database.collection("orders");

    // products related api
    // post a product
    app.post("/api/products", async (req, res) => {
      const product = req.body;
      // console.log(product);
      const result = await productsCollection.insertOne(product);

      res.send(result);
    });

    // get my products
    app.get("/api/my-products", async (req, res) => {
      const sellerInfo = req.query.sellerInfo;
      const result = await productsCollection.find({ sellerInfo }).toArray();
      res.send(result);
    });

    // get all products
    app.get("/api/products", async (req, res) => {
      const result = await productsCollection.find({}).toArray();
      res.send(result);
    });

    // get a single product

    app.get("/api/products/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await productsCollection.findOne(query);
      res.send(result);
    });

    // edit a product
    app.patch("/api/products/:id", async (req, res) => {
      const id = req.params;
      const updatedProduct = req.body;
      const result = await productsCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: updatedProduct,
        },
      );
      res.send(result);
    });

    // delete a product
    app.delete("/api/products/:id", async (req, res) => {
      const { id } = req.params;

      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });
    // get featured products
    app.get("/api/featured", async (req, res) => {
      const result = await productsCollection.find({}).limit(6).toArray();
      res.send(result);
    });

    // reviews related api
    // post review
    app.post("/api/reviews", async (req, res) => {
      const review = req.body;
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });

    // get review
    app.get("/api/reviews", async (req, res) => {
      const productId = req.query.productId;
      const result = await reviewsCollection
        .find({ "review.productId": productId })
        .toArray();

      res.send(result);
    });

    // get avarage rating of a product

    app.get("/api/reviews/avarage-rating", async (req, res) => {
      const productId = req.query.productId;
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
        return res.send({
          avarageRating: 0,
        });
      }
      res.send({
        avarageRating: Number(result[0].avarageRating.toFixed(1)),
      });
    });

    // orders related api

    app.post("/api/orders", async (req, res) => {
      const orderData = req.body;
      const result = await ordersCollection.insertOne({
        ...orderData,
        createdAt: new Date(),
      });
      res.send(result);
    });

    // get orders by sellerInfo

    app.get("/api/seller/orders", async (req, res) => {
      const sellerInfo = req.query.sellerInfo;
      const result = await ordersCollection.find({ sellerInfo }).toArray();
      res.send(result);
    });


    // get orders by buyerInfo

    app.get("/api/buyer/orders", async(req,res)=>{
      const buyerInfo = req.query.buyerInfo;
      console.log(buyerInfo);
      const result = await ordersCollection.find({ buyerInfo }).toArray();
      res.send(result);
    })

   

    // api to edit order status
    // update order status
    app.patch("/api/orders/:orderId/status", async (req, res) => {
      const { orderId } = req.params;
      const { status } = req.body;

      const allowedStatuses = [
        "accepted",
        "rejected",
        "processing",
        "shipped",
        "delivered",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(orderId) },
        { $set: { orderStatus: status, updatedAt: new Date() } },
      );

      res.send(result);
    });

    // wishlist relates api

    // add a wishlist item

    app.post("/api/wishlist", async (req, res) => {
      const wishlistItem = req.body;
      const result = await wishlistCollection.insertOne(wishlistItem);
      res.send(result);
    });

    // payments history related apis

    app.post("/api/payments", async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
