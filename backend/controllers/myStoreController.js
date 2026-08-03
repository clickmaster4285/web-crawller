/**
 * MyStore controller — read/write the user's own store (single document).
 * The store appears in the competitors list as a special "my store" row
 * (see dataController) and can be compared against any competitor.
 */

const MyStore = require('../models/MyStore');

const getMyStore = async (req, res) => {
  try {
    const doc = await MyStore.findById(MyStore.MY_STORE_ID);
    res.json({
      success: true,
      data: doc ? { origin: doc.origin, name: doc.name } : null
    });
  } catch (error) {
    console.error('Get my store error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const setMyStore = async (req, res) => {
  try {
    const { origin, name } = req.body || {};
    const normalized = String(origin || '').trim();
    if (!/^https?:\/\/\S+$/i.test(normalized)) {
      return res.status(400).json({
        success: false,
        message: 'Origin must be a valid http(s) URL'
      });
    }
    let doc = await MyStore.findById(MyStore.MY_STORE_ID);
    if (!doc) {
      doc = new MyStore({ _id: MyStore.MY_STORE_ID });
    }
    doc.origin = normalized;
    doc.name = String(name || '').trim() || 'My store';
    await doc.save();
    console.log(`🏪 Your store set to: ${doc.name} (${doc.origin})`);
    res.json({ success: true, data: { origin: doc.origin, name: doc.name } });
  } catch (error) {
    console.error('Set my store error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { getMyStore, setMyStore };
