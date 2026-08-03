/**
 * MyStore — the user's own store, stored as a single document (fixed _id)
 * so it can be compared against competitors. Read/written via
 * `GET/PUT /api/data/my-store`.
 */
const mongoose = require('mongoose');

/** Fixed document id — there is exactly one "my store" entry. */
const MY_STORE_ID = '000000000000000000000001';

const myStoreSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: 'My store',
      trim: true
    },
    origin: {
      type: String,
      required: [true, 'Origin URL is required'],
      trim: true,
      lowercase: true
    }
  },
  { timestamps: true }
);

const MyStore = mongoose.model('MyStore', myStoreSchema);
MyStore.MY_STORE_ID = MY_STORE_ID;

module.exports = MyStore;
