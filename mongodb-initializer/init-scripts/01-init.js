// Initialize database
db = db.getSiblingDB('docgen');
print('Connected to docgen database');

// Create collections
// Check if this is first-time initialization
const collections = db.getCollectionNames();
if (collections.length === 0) {
  // Only create collections and indexes if none exist
  db.createCollection('favorites');
  print('Created favorites collection');

  // Create indexes
  db.favorites.createIndex({ userId: 1, docType: 1, name: 1 }, { unique: true });
  db.favorites.createIndex({ id: 1 }, { unique: true });
} else {
  print('Collections already exist, skipping initialization');
}

print('MongoDB initialization complete!');
