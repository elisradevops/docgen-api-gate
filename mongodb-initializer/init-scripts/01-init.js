// Initialize database
db = db.getSiblingDB('docgen');
print('Connected to docgen database');

// Drop existing collections to ensure clean state
try {
  // db.favorites.drop(); // Commented out to prevent data deletion
  print('Favorites collection will not be dropped to preserve data.');
} catch (e) {
  print('No favorites collection to drop (or drop is commented out)');
}

// Create collections
db.createCollection('favorites');
print('Created favorites collection');

// Create indexes matching those defined in DatabaseController.ts
db.favorites.createIndex({ userId: 1, docType: 1, name: 1, teamProjectId: 1 }, { unique: true });
print('Created compound index on favorites collection');

// Create index for id field
db.favorites.createIndex({ id: 1 }, { unique: true });
print('Created unique index on id field');

print('MongoDB initialization complete!');
