const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Razorpay instance with test keys
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Database
const db = new sqlite3.Database('./courses.db');

db.serialize(() => {
    // Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Courses (all paid)
    db.run(`CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        course_key TEXT UNIQUE NOT NULL,
        course_url TEXT NOT NULL,
        is_paid INTEGER DEFAULT 1
    )`);
    
    // Enrollments
    db.run(`CREATE TABLE IF NOT EXISTS enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        progress INTEGER DEFAULT 0,
        enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(course_id) REFERENCES courses(id),
        UNIQUE(user_id, course_id)
    )`);
    
    // Orders
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        razorpay_order_id TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        payment_id TEXT,
        status TEXT DEFAULT 'created',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Insert all courses (all paid, price in paise, link to sivateam007.github.io)
    const courses = [
        ['html', 'HTML Tutorial', 'Learn HTML from basics to advanced. Create web pages with proper structure.', 4999, 'https://sivateam007.github.io/html'],
        ['css', 'CSS Tutorial', 'Master CSS styling, layouts, and animations. Responsive design.', 4999, 'https://sivateam007.github.io/css'],
        ['mongodb', 'MongoDB Tutorial', 'Learn MongoDB database design and queries.', 5999, 'https://sivateam007.github.io/mongodb'],
        ['nodejs', 'Node.js Tutorial', 'Build server-side applications with Node.js.', 6999, 'https://sivateam007.github.io/nodejs'],
        ['python', 'Python Tutorial', 'Complete Python programming from basics to advanced.', 7999, 'https://sivateam007.github.io/python'],
        ['sql', 'SQL Tutorial', 'Master SQL queries and database management.', 4999, 'https://sivateam007.github.io/sql'],
        ['git', 'Git Tutorial', 'Version control with Git and GitHub workflows.', 3999, 'https://sivateam007.github.io/git'],
        ['webdev_bootcamp', 'Web Dev Bootcamp', 'Full-stack web development with HTML, CSS, JS, React.', 9999, 'https://sivateam007.github.io/webdev'],
        ['react_nextjs', 'React & Next.js', 'Modern React development with Next.js framework.', 10999, 'https://sivateam007.github.io/react']
    ];
    courses.forEach(c => {
        db.run(`INSERT OR IGNORE INTO courses (course_key, name, description, price, course_url) VALUES (?, ?, ?, ?, ?)`, c);
    });
});

// JWT middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// ========== AUTH ROUTES ==========
app.post('/api/signup', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`, [name, email, hashed], function(err) {
            if (err) return res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Email exists' : 'Database error' });
            const token = jwt.sign({ id: this.lastID, email, name }, process.env.JWT_SECRET, { expiresIn: '7d' });
            res.json({ token, user: { id: this.lastID, name, email } });
        });
    } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    });
});

// ========== COURSE & ENROLLMENT ROUTES ==========
// Get all courses (for display)
app.get('/api/courses', (req, res) => {
    db.all(`SELECT * FROM courses`, [], (err, courses) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ courses });
    });
});

// Get user's enrolled courses (with course details)
app.get('/api/my-enrollments', authenticateToken, (req, res) => {
    const userId = req.user.id;
    db.all(`
        SELECT c.*, e.enrolled_at, e.progress 
        FROM enrollments e 
        JOIN courses c ON e.course_id = c.id 
        WHERE e.user_id = ?
    `, [userId], (err, courses) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ enrolled: courses });
    });
});

// Check if user is enrolled in a specific course
app.get('/api/check-enrollment/:course_key', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { course_key } = req.params;
    db.get(`SELECT id FROM courses WHERE course_key = ?`, [course_key], (err, course) => {
        if (err || !course) return res.status(404).json({ enrolled: false });
        db.get(`SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?`, [userId, course.id], (err, enrollment) => {
            res.json({ enrolled: !!enrollment });
        });
    });
});

// ========== RAZORPAY ROUTES ==========
app.post('/api/create-order', authenticateToken, (req, res) => {
    const { course_key } = req.body;
    const userId = req.user.id;
    db.get(`SELECT * FROM courses WHERE course_key = ?`, [course_key], async (err, course) => {
        if (err || !course) return res.status(404).json({ error: 'Course not found' });
        // Check if already enrolled
        db.get(`SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?`, [userId, course.id], (err, enrolled) => {
            if (enrolled) return res.status(400).json({ error: 'Already enrolled' });
            const options = {
                amount: course.price,
                currency: 'INR',
                receipt: `receipt_${userId}_${Date.now()}`,
                notes: { course_id: course.id, user_id: userId, course_key }
            };
            razorpay.orders.create(options, (err, order) => {
                if (err) return res.status(500).json({ error: 'Razorpay error' });
                db.run(`INSERT INTO orders (razorpay_order_id, user_id, course_id, amount) VALUES (?, ?, ?, ?)`, [order.id, userId, course.id, course.price]);
                res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID, course_name: course.name, course_url: course.course_url });
            });
        });
    });
});

app.post('/api/verify-payment', authenticateToken, (req, res) => {
    const { order_id, payment_id, signature, course_key } = req.body;
    const body = order_id + "|" + payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    if (expected !== signature) return res.json({ success: false, error: 'Invalid signature' });
    db.get(`SELECT * FROM orders WHERE razorpay_order_id = ?`, [order_id], (err, order) => {
        if (err || !order) return res.json({ success: false, error: 'Order not found' });
        db.run(`UPDATE orders SET status = 'paid', payment_id = ? WHERE razorpay_order_id = ?`, [payment_id, order_id]);
        db.run(`INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)`, [order.user_id, order.course_id]);
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`💰 Razorpay Test Mode: ${process.env.RAZORPAY_KEY_ID}`);
});