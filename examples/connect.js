// Run on your backend or locally. Never send a management key to an agent.
const base = process.env.APP_URL || 'http://127.0.0.1:3100';
if (!process.env.MANAGEMENT_KEY) throw new Error('Set MANAGEMENT_KEY for the customer you want to connect.');
const response = await fetch(base + '/v1/notion/connect', {
  method: 'POST', headers: { Authorization: 'Bearer ' + process.env.MANAGEMENT_KEY }
});
const data = await response.json();
if (!response.ok) throw new Error(data.message);
console.log('Open this one-use link in your browser within 10 minutes:\n' + data.connect_url);
