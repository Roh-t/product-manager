require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serves index.html

// 1. Connect to PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 2. Initialize AWS S3
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Multer holds image in memory temporarily before sending to AWS
const upload = multer({ storage: multer.memoryStorage() });

async function ensureDatabaseSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);
  `);
}

// ==========================================
// 1. POST API: Upload to S3 + Save to DB
// ==========================================
app.post('/api/products', upload.single('image'), async (req, res) => {
  try {
    const { name, brand, pack_size, price, category_name } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'Please choose an image file!' });
    }

    const categoryName = category_name && category_name.trim();
    if (!categoryName) {
      return res.status(400).json({ error: 'Please choose or enter a category!' });
    }

    // A. Generate unique image name (avoids file overwrites)
    const fileExtension = path.extname(file.originalname);
    const uniqueFileName = `products/${crypto.randomUUID()}${fileExtension}`;

    // B. Upload file to AWS S3
    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: uniqueFileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
    await s3.send(new PutObjectCommand(uploadParams));

    // C. Build the public AWS image link
    const imageUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueFileName}`;

    // D. Insert into Database
    const client = await pool.connect();
    let dbResult;
    try {
      await client.query('BEGIN');
      const categoryResult = await client.query(
        `INSERT INTO categories (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [categoryName]
      );
      const category = categoryResult.rows[0];
      dbResult = await client.query(
        `INSERT INTO products (name, brand, pack_size, price, image_url, category_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [name, brand, pack_size, parseFloat(price), imageUrl, category.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.status(201).json({
      message: 'Product created successfully!',
      product: dbResult.rows[0],
    });

  } catch (error) {
    console.error('Upload Error:', error);
    res.status(500).json({ error: 'Failed to upload product', details: error.message });
  }
});

app.put('/api/products/:id', upload.single('image'), async (req, res) => {
  try {
    const { name, brand, pack_size, price, category_name } = req.body;
    const categoryName = category_name && category_name.trim();
    if (!name || !brand || !pack_size || !price || !categoryName) {
      return res.status(400).json({ error: 'Please complete all product fields.' });
    }

    const existing = await pool.query('SELECT id, image_url FROM products WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    let imageUrl = existing.rows[0].image_url;
    if (req.file) {
      const fileExtension = path.extname(req.file.originalname);
      const uniqueFileName = `products/${crypto.randomUUID()}${fileExtension}`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: uniqueFileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));
      imageUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueFileName}`;
    }

    const client = await pool.connect();
    let dbResult;
    try {
      await client.query('BEGIN');
      const categoryResult = await client.query(
        `INSERT INTO categories (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [categoryName]
      );
      dbResult = await client.query(
        `UPDATE products
         SET name = $1, brand = $2, pack_size = $3, price = $4,
             image_url = $5, category_id = $6
         WHERE id = $7
         RETURNING *`,
        [name, brand, pack_size, parseFloat(price), imageUrl, categoryResult.rows[0].id, req.params.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({ message: 'Product updated successfully!', product: dbResult.rows[0] });
  } catch (error) {
    console.error('Update Error:', error);
    res.status(500).json({ error: 'Failed to update product', details: error.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ message: 'Product deleted successfully.' });
  } catch (error) {
    console.error('Delete Error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ==========================================
// 2. GET API: Fetch All Products from DB
// ==========================================
app.get('/api/products', async (req, res) => {
  try {
    const result = await getProducts();
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch Error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

async function getProducts() {
  return pool.query(`
    SELECT products.id, products.name, products.brand, products.pack_size,
           products.price, products.image_url, products.created_at,
           categories.name AS category_name
    FROM products
    LEFT JOIN categories ON categories.id = products.category_id
    ORDER BY products.id DESC
  `);
}

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

app.get('/api/products/export', async (req, res) => {
  try {
    const result = await getProducts();
    const format = req.query.format || 'json';

    if (format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename="products.json"');
      return res.json(result.rows);
    }

    if (format === 'csv') {
      const columns = [
        'id',
        'name',
        'brand',
        'pack_size',
        'price',
        'category_name',
        'image_url',
        'created_at',
      ];
      const csv = [
        columns.join(','),
        ...result.rows.map(product =>
          columns.map(column => escapeCsvValue(product[column])).join(',')
        ),
      ].join('\r\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
      return res.send(`\uFEFF${csv}`);
    }

    res.status(400).json({ error: 'Unsupported export format. Use json or csv.' });
  } catch (error) {
    console.error('Export Error:', error);
    res.status(500).json({ error: 'Failed to export products' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM categories ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Category Fetch Error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

const PORT = process.env.PORT || 3000;
ensureDatabaseSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database initialization Error:', error);
    process.exitCode = 1;
  });