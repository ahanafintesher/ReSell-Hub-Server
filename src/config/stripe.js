const Stripe = require("stripe");
const { config } = require("./env");

let stripeInstance = new Stripe(config.STRIPE_SECRET_KEY || "");

const getStripeInstance = () => stripeInstance;

const setStripeInstance = (instance) => {
  stripeInstance = instance;
};

module.exports = {
  getStripeInstance,
  setStripeInstance,
};
