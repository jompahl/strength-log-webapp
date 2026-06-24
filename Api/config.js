// api/config.js — serves the public OAuth client ID to the frontend.
// (The client ID is not a secret; the private service-account key stays server-only.)
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
};
