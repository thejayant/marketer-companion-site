// config.js — fill in your OAuth details
export const CLIENT_ID = "1099294114553-j4hs38ccmrjnfuj71lh33vgrn9ecu07j.apps.googleusercontent.com";
// optional: if your web client insists on a secret, set it here; leave blank to skip
export const CLIENT_SECRET = ""; // e.g. "GOCSPX-xxxxx_your_secret_xxxxx"

export const SCOPES = [
  "openid",
  "email", 
  "https://www.googleapis.com/auth/webmasters.readonly",
  'https://www.googleapis.com/auth/webmasters',          // needed for URL Inspection & sites.list
  "https://www.googleapis.com/auth/analytics.readonly"
].join(" ");

// Optional but recommended for Live Test stability.
// Create an API key in Google Cloud (free), enable Search Console API,
// and paste it here. If empty, OAuth will be used for Live Test.
export const PSI_API_KEY = ""; // e.g. "AIzaSyB......"


