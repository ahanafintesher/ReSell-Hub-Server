## **A10_CAT001** 

##### <u>🎬</u> **<u>Video Explanation:</u> b13A10-req-cat-1.mp4** 

## **Project Name: ReSell Hub – Second-Hand Marketplace Platform)** 

Dear Candidates, 

We are pleased to inform you that you have successfully passed the first round of the selection process!! 

Your application and skills have impressed us, and we are excited to move forward with you in the next stages. 

This project is designed to assess your skills, creativity, and problem-solving abilities. It will help us understand how you approach challenges and your ability to deliver high-quality solutions. 

# **Project Overview & Discussion** 

###### **What is ReSell Hub?** 

ReSell Hub is an online marketplace where users can buy and sell pre-owned products safely and efficiently. 

Users can list products they no longer need, while buyers can browse products, communicate with sellers, and purchase items. 

###### **Why Should We Develop This Project?** 

Many people own products that are still usable but no longer needed. 

This platform helps: 

- Reduce waste 

- Promote sustainable consumption 

- Create opportunities for users to earn money from unused items 

- ● Help buyers find affordable products 

###### **How the System Works** 

1. Seller creates an account. 

2. Seller lists products with details and images. 

3. Buyers browse available products. 

4. Buyers can view product details and place orders. 

5. Payment is completed through the platform. 

6. Seller manages orders. 

7. Admin monitors all activities and users. 

###### **Similar Websites** 

- Bikroy.com 

- Facebook Marketplace 

- ● eBay 

- OLX 

# **Data Design Suggested Collections)** 

###### **Collection 1 Users** 

{ "_id": "user001", "name": "Md. Rakib Hasan", "email": "rakib.hasan@gmail.com", "photo": "https://i.pravatar.cc/300?img=1", "role": "buyer", "phone": "8801712345678", 

"location": "Dhaka, Bangladesh", 

"status": "active" } 

###### **Collection 2 Products** 

{ "_id": "product001", "title": "Used Dell Inspiron 15 Laptop", "category": "Electronics", "condition": "Good", "price": 35000, "images": [ "https://example.com/images/laptop1.jpg", "https://example.com/images/laptop2.jpg" ], 

"description": "Dell Inspiron 15, Core i5 10th Gen, 8GB RAM, 512GB SSD. Used for 2 years.", "sellerInfo": { 

"userId": "user002", "name": "Nusrat Jahan", "email": "nusrat.jahan@gmail.com", "phone": "8801812345678" }, "status": "available" 

} 

###### **Collection 3 Orders** 

{ 

"_id": "order001", "buyerInfo": { "userId": "user001", "name": "Md. Rakib Hasan", 

"email": "rakib.hasan@gmail.com" }, "sellerInfo": { "userId": "user002", "name": "Nusrat Jahan", 

"email": "nusrat.jahan@gmail.com" }, "productId": "product001", 

"paymentStatus": "paid", "orderStatus": "processing" 

} 

###### **Collection 4 Reviews** 

{ "_id": "review001", "reviewerInfo": { 

"userId": "user001", 

"name": "Md. Rakib Hasan" }, "productId": "product001", 

"rating": 5, 

"comment": "Laptop condition was exactly as described. Highly recommended seller." 

} 

###### **Collection 5 Payments** 

{ "_id": "payment001", 

"orderId": "order001", 

"transactionId": "BKASHTRX987654321", 

"amount": 35000, 

"paymentStatus": "success" 

} 

# **Ensure the Following Things to Get Full Marks** 

###### **Git Requirements** 

- Minimum 20 meaningful client-side commits 

- Minimum 12 meaningful server-side commits 

- Commit messages must be descriptive 

###### **README Requirements** 

Include: 

- Project Name 

- Project Purpose 

- Live URL 

- Key Features 

- NPM Packages Used 

###### **Security Requirements** 

- Use environment variables for Better auth keys 

- Use environment variables for MongoDB credentials 

- Secure JWT secret key 

###### **Deployment Requirements** 

- **No CORS issues** 

- **No 404 errors** 

- **No 504 errors** 

- **Live website must work properly** 

- **Reloading any route should not show errors** 

- **Private routes must remain logged in after reload** 

# **Layout & Page Structure** 

#### **Navbar** 

Must Include: 

- Logo 

- Home 

- Products 

- Categories 

- Dashboard 

- Login/Register 

- User Profile Dropdown 



<!-- Start of picture text -->
\ 4 & My Profile<br>® Settings<br>. com<br>a<br><!-- End of picture text -->

#### **Footer** 

Must Include: 

- Brand Information 

- Quick Links 

- Contact Information 

- ● Social Media Links 

- Copyright Section 

### **Main Pages** 

###### **Public Pages** 

- Home 

- All Products 

- Product Details 

- ● Categories 

- About Us 

- Contact Us 

- Login 

- Register 

###### **Private Pages** 

- Dashboard 

- Add Product 

- My Products 

- My Orders 

- Wishlist 

- Profile Settings 

# **Authentication System** 

#### **Registration** 

Users must be able to: 

- Register using username, email and password 

- Register using  Google 

#### **Login** 

Users must be able to: 

- Login using email and password 

- Login with Google 

- Logout securely 

#### **JWT Authentication** 

- Protect private routes 

- Protect private APIs 

- Verify token in backend 

# **Home Page Requirements** 

#### **Section 1 – Hero Banner** 

Must Include: 

- Attractive Banner 

- CTA Button 

- Statistics 

#### **Section 2 – Featured Products Dynamic)** 

Show latest products from database. U 

#### **Section 3 – Popular Categories Dynamic)** 

Example: 

- Electronics 

- Furniture 

- Vehicles 

- Fashion 

- Mobile Phones 

#### **Section 4 – Success Stories** 

Show buyer and seller success stories. 

#### **Section 5 – Marketplace Statistics** 

Display: 

- Total Products 

- Total Sellers 

- Total Buyers 

- Completed Orders 

#### **Animation Requirement** 

Must use: 

- Framer Motion / Motion 

Apply animation on: 

- Hero Section 

- Product Cards 

- Statistics Section 

#### **Extra Section 1** 

###### **Sustainability Impact** 

Show how second-hand buying helps reduce waste. 

#### **Extra Section 2** 

###### **Trusted Sellers Showcase** 

Display top-rated sellers. 

# **Dashboard & Role-Based Features** 

The platform has three different user roles: 

1. Buyer 

2. Seller 

3. Admin 

Each role will have its own dashboard with specific features and permissions. 

# **Buyer Dashboard** 

#### **Dashboard Overview** 

After login, a buyer should see a summary of their activity. 

###### **Display Cards** 

- Total Orders → Total number of orders placed by the buyer. 

- Wishlist Count → Number of products saved in wishlist. 

- Recent Purchases → Latest purchased products. 

#### **My Orders** 

Buyers can manage all their orders from this page. 

###### **Features** 

- View all orders. 

- View order details. 

- Cancel an order (before shipment). 

- Track current order status. 

###### **Order Status Examples** 

- Pending 

- Accepted 

- Cancelled 

#### **Wishlist** 

Buyers can save products for future purchase. 

###### **Features** 

- Add products to wishlist. 

- Remove products from wishlist. 

- View all saved products. 

- Navigate to product details page. 

#### **Payment History** 

Displays all payment records of the buyer. 

###### **Features** 

- View transaction history. 

- See payment amount. 

- View payment date. 

- View payment status. 

#### **Profile Management** 

Buyers can manage their personal information. 

###### **Features** 

- Update name. 

- Update profile image. 

# **Seller Dashboard** 

#### **Dashboard Overview** 

After login, sellers should see business-related statistics. 

###### **Display Cards** 

- Total Products → Number of products listed by the seller. 

- Total Sales → Total completed sales. 

- Total Revenue → Earnings from completed orders. 

- Pending Orders → Orders waiting for action. 

#### **Add Product** 

Sellers can create new product listings. 

###### **Features** 

- Upload product image. 

- Add product title. 

- Add description. 

- Set category. 

- Set condition Used / Like New / Refurbished). 

- ● Set price. 

- Set stock quantity. 

###### **CRUD Operations** 

- Create Product 

#### **My Products** 

Manage all products created by the seller. 

###### **Features** 

- View product list. 

- Edit product information. 

- Delete product. 

- Search and filter products. 

###### **CRUD Operations** 

- Read 

- Update 

- Delete 

#### **Manage Orders** 

Handle incoming customer orders. 

###### **Features** 

- View incoming orders. 

- Accept order. 

- Reject order. 

- Update delivery status. 

- View buyer information. 

###### **Order Status Flow** 

Pending → Accepted → Processing → Shipped → Delivered 

#### **Sales Analytics** 

Visual representation of seller performance. 

###### **Charts** 

- Sales Chart 

- Monthly Sales Trend 

- Top Selling Products 

If you canʼt use real dynamic data from your DB then you can use fake data for this Chart page) 

# **Admin Dashboard** 

#### **Dashboard Overview** 

The admin has full control over the platform. 

###### **Display Cards** 

- Total Users 

- Total Products 

- Total Orders 

#### **Manage Users** 

Admin can monitor and control platform users. 

###### **Features** 

- View all users. 

- Search users. 

- Update user status. 

- Block/Unblock users. 

- Delete user accounts. 

###### **CRUD Operations** 

- Read 

- Update Status 

- Delete 

#### **Manage Products** 

Admin reviews and moderates all product listings. 

###### **Features** 

- View all products. 

- Approve products. 

- Reject products. 

- Delete products. 

- Monitor reported products. 

###### **Actions** 

- Read 

- Approve 

- Reject 

- Delete 

#### **Manage Orders** 

Admin can monitor all orders across the platform. 

###### **Features** 

- View all orders. 

- Track order status. 

- Resolve disputes. 

- Update order status when necessary. 

#### **Platform Analytics** 

Provides overall business insights. 

###### **Charts** 

- User Growth Chart 

- Category Performance Chart 

- Monthly Orders Chart 

- Top Categories Chart 

###### **Purpose** 

These analytics help administrators understand platform growth, user activity, product performance, and overall revenue trends. 

If you canʼt use real dynamic data from your DB then you can use fake data for this Chart page) 

# **Payment System** 

The platform must integrate Stripe Payment Gateway for secure online transactions. 

#### **Payment Workflow** 

1. Buyer adds products to cart. 

2. Buyer proceeds to checkout. 

3. Buyer completes payment using Stripe. 

4. Order is created after successful payment. 

5. Payment information is stored in the database. 

6. Buyer is redirected to the Payment Success page. 

#### **Required Features** 

###### **Secure Checkout** 

Buyers should be able to make payments securely through Stripe. 

###### **Features** 

- Stripe Payment Integration 

- Secure Card Payment 

- Payment Validation 

- Protected Payment Route 

- Loading & Error Handling 

###### **Checkout Page** 

Displays order summary before payment. 

###### **Information to Show** 

- Product Name 

- Product Price 

- Quantity 

- Total Amount 

- Delivery Information 

###### **Actions** 

- Proceed to Payment 

- Cancel Checkout 

###### **Payment Success Page** 

After successful payment, users should be redirected to a success page. 

###### **Information to Show** 

- Success Message 

- Order Summary 

- Payment Amount 

- Transaction ID 

- Payment Date 

###### **Actions** 

- View Order Details 

- Go to My Orders 

- Continue Shopping 

###### **Payment History** 

Buyers can view all previous payment records. 

###### **Features** 

- View all transactions 

- View payment amount 

- View payment date 

- View payment status 

- View transaction ID 

###### **Transaction Management** 

Payment information should be stored in the database. 

###### **Store the Following Information** 

- Transaction ID 

- Buyer ID 

- Order ID 

- Payment Amount 

- Payment Status 

- Payment Method 

- Payment Date 

#### **Payment Status** 

The system should support the following statuses: 

- Pending 

- Paid 

- Failed 

#### **Admin Monitoring** 

Admins should be able to monitor payment activities. 

###### **Features** 

- View all transactions 

- Search transactions 

- Filter by status 

- Monitor revenue 

#### **Database Requirements** 

Each successful payment should: 

- Generate a unique Transaction ID. 

- Update Order Status. 

- Save payment details in the database. 

- Appear in the buyer's Payment History. 

# **Loading Page** 

Must Include: 

- Professional Loader 

- Skeleton Loading for Product Cards 

# **Error Page** 

Must Include: 

- Custom 404 Page 

- Back To Home Button 

- Attractive Illustration 

# **Challenge Requirements** 

###### **Challenge 1** 

Advanced Search & Advanced Sorting 

Search products by: 

- Name 

- Category 

Sort by: 

- Price Low to High 

- Price High to Low 

###### **Challenge 2** 

Pagination 

Implement pagination on: 

- All Products Page 

###### **Challenge 3** 

###### JWT Token Verification 

- Verify token on private APIs 

- Role-based authorization 

# **UI Design Requirements** 

###### **Design Quality** 

- Modern Marketplace Design 

- Professional Color Combination 

- Recruiter-Friendly UI 

###### **Consistency** 

- Same heading style throughout website 

- Same button style 

- Consistent spacing 

###### **Cards** 

- Equal height 

- Equal width 

- Proper image ratio 

###### **Responsive Design** 

Must support: 

- Mobile 

- Tablet 

- Desktop 

# **Dashboard UI Requirements** 

- Full Width Dashboard 

- Responsive Sidebar 

- User Profile Section 

- Charts & Graphs 

- Consistent Theme 

# **What to Submit ?...** 

Admin Email: 

Admin Password: 

Live Site Link: 

Github Repository Client 

Github Repository Server 

# **Optional Requirements….** 

Students must implement a minimum of **2 Optional Features** . Those who complete more optional features can make their project stand out from others. 

###### **1. Product Comparison Feature** 

Allow users to compare two or more products side-by-side based on: 

- Price 

- Condition 

- Category 

- Seller Rating 

###### **2. Recently Viewed Products** 

Track and display products recently viewed by the user for quick access. 

###### **3. Dark / Light Theme Toggle** 

Provide users with the ability to switch between: 

- Light Mode 

- Dark Mode 

The selected theme should persist after page reload. 

###### **4. Seller Verification Badge** 

Admin can verify trusted sellers. 

Verified sellers will receive a special badge that is displayed on: 

- Product Cards 

- Product Details Page 

- Seller Profile 

###### **5. Product Reporting System** 

Allow users to report suspicious, misleading, or inappropriate product listings. Features: 

- Report Product Button 

- Report Reason Selection 

- Admin Review Panel 

- Report Status Tracking 

###### **6. Product Availability Alerts** 

Users can subscribe to receive notifications when an unavailable product becomes available again. 

###### **7. Advanced Product Filtering** 

Add multiple filters such as: 

- Price Range 

- Condition 

- Category 

- Location 

###### **8. Seller Public Profile Page** 

Create a public profile page for sellers showing: 

- Seller Information 

- Total Listings 

- Ratings & Reviews 

- Joined Date 

**Note:** Any additional feature beyond the mandatory requirements should be properly documented in the README file. 

