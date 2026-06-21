const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();
const app = express();
const port = 5000;
const uri = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());


app.get('/', (req, res) => {
  res.send('Hello World!');
});



// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
   
    await client.connect();

    const database = client.db('resell_hub');
    const productsCollection = database.collection('products');
    
    // products related api

    app.post('/api/products', async (req, res) => {
      const product = req.body;
      console.log(product);
      const result = await productsCollection.insertOne(product);
      
      res.send(result);
      
    });

    // get my products
    app.get('/api/my-products', async(req,res)=>{
      const sellerInfo = req.query.sellerInfo;
      const result = await productsCollection.find({ sellerInfo }).toArray();
      res.send(result);
    })
    // get all products
    app.get('/api/products', async(req,res)=>{
      const result = await productsCollection.find({}).toArray();
      res.send(result);
    })

    // 
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
   
    // await client.close();
  }
}
run().catch(console.dir);


app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});