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

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Razorpay with YOUR test keys
const razorpay = new Razorpay({
    key_id: 'rzp_test_SdoHI00hjGMUoA',
    key_secret: '2lAUgaw4AiyMciCDuHxP9hFq'
});

console.log('Razorpay initialized with test key:', 'rzp_test_SdoHI00hjGMUoA');

// Initialize Database
const db = new sqlite3.Database('./courses.db');

// Create tables
db.serialize(() => {
    // Users table
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Courses table
    db.run(`
        CREATE TABLE IF NOT EXISTS courses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            price INTEGER NOT NULL,
            course_key TEXT UNIQUE NOT NULL
        )
    `);
    
    // Enrollments table
    db.run(`
        CREATE TABLE IF NOT EXISTS enrollments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            course_id INTEGER NOT NULL,
            progress INTEGER DEFAULT 0,
            enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (course_id) REFERENCES courses(id),
            UNIQUE(user_id, course_id)
        )
    `);
    
    // Orders table for Razorpay
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            razorpay_order_id TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            course_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            payment_id TEXT,
            status TEXT DEFAULT 'created',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (course_id) REFERENCES courses(id)
        )
    `);
    
    // Insert sample courses (prices in paise - ₹49.99 = 4999 paise)
    const courses = [
        ['python', 'Python Mastery', 'Complete Python programming course with 10 projects', 4999],
        ['webdev', 'Web Dev Bootcamp', 'Full-stack web development with HTML, CSS, JavaScript', 7999],
        ['react', 'React & Next.js', 'Modern React development with Next.js framework', 9999]
    ];
    
    courses.forEach(course => {
        db.run(
            'INSERT OR IGNORE INTO courses (course_key, name, description, price) VALUES (?, ?, ?, ?)',
            course
        );
    });
});

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// ============ AUTHENTICATION ROUTES ============

// Signup
app.post('/api/signup', async (req, res) => {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Email already exists' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }
                
                const token = jwt.sign(
                    { id: this.lastID, email, name },
                    process.env.JWT_SECRET || 'your-secret-key',
                    { expiresIn: '7d' }
                );
                
                res.json({
                    token,
                    user: { id: this.lastID, name, email }
                });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '7d' }
        );
        
        res.json({
            token,
            user: { id: user.id, name: user.name, email: user.email }
        });
    });
});

// ============ RAZORPAY PAYMENT ROUTES ============

// Create Razorpay Order
app.post('/api/create-order', authenticateToken, async (req, res) => {
    const { course_key } = req.body;
    const userId = req.user.id;
    
    try {
        // Get course details from database
        db.get('SELECT * FROM courses WHERE course_key = ?', [course_key], async (err, course) => {
            if (err || !course) {
                return res.status(404).json({ error: 'Course not found' });
            }
            
            // Check if already enrolled
            db.get('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?', 
                [userId, course.id], async (err, enrollment) => {
                if (enrollment) {
                    return res.status(400).json({ error: 'Already enrolled in this course' });
                }
                
                try {
                    // Create order in Razorpay (amount in paise)
                    const options = {
                        amount: course.price,
                        currency: 'INR',
                        receipt: `receipt_${userId}_${Date.now()}`,
                        notes: {
                            course_id: course.id,
                            course_name: course.name,
                            user_id: userId
                        }
                    };
                    
                    const order = await razorpay.orders.create(options);
                    console.log('Order created:', order.id);
                    
                    // Save order to database
                    db.run(
                        `INSERT INTO orders (razorpay_order_id, user_id, course_id, amount, status) 
                         VALUES (?, ?, ?, ?, 'created')`,
                        [order.id, userId, course.id, course.price]
                    );
                    
                    res.json({
                        success: true,
                        orderId: order.id,
                        amount: order.amount,
                        currency: order.currency,
                        keyId: 'rzp_test_SdoHI00hjGMUoA',
                        course_name: course.name,
                        course_price: course.price / 100
                    });
                    
                } catch (razorpayError) {
                    console.error('Razorpay error:', razorpayError);
                    res.status(500).json({ error: 'Failed to create payment order: ' + razorpayError.message });
                }
            });
        });
        
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Verify Payment
app.post('/api/verify-payment', authenticateToken, (req, res) => {
    const { order_id, payment_id, signature, course_key } = req.body;
    const userId = req.user.id;
    
    // Verify signature
    const body = order_id + "|" + payment_id;
    const expectedSignature = crypto
        .createHmac('sha256', '2lAUgaw4AiyMciCDuHxP9hFq')
        .update(body.toString())
        .digest('hex');
    
    if (expectedSignature === signature) {
        // Update order status and add payment_id
        db.run(
            `UPDATE orders SET status = 'paid', payment_id = ? WHERE razorpay_order_id = ?`,
            [payment_id, order_id],
            function(err) {
                if (err) {
                    console.error('Order update error:', err);
                    return res.json({ success: false, error: 'Database error' });
                }
                
                // Get order details to find course_id
                db.get('SELECT * FROM orders WHERE razorpay_order_id = ?', [order_id], (err, order) => {
                    if (err || !order) {
                        return res.json({ success: false, error: 'Order not found' });
                    }
                    
                    // Enroll user in course
                    db.run(
                        `INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)`,
                        [userId, order.course_id],
                        function(err) {
                            if (err) {
                                console.error('Enrollment error:', err);
                                return res.json({ success: false, error: 'Failed to enroll' });
                            }
                            
                            res.json({ 
                                success: true, 
                                message: 'Payment verified and enrollment successful' 
                            });
                        }
                    );
                });
            }
        );
    } else {
        res.json({ success: false, error: 'Invalid payment signature' });
    }
});

// ============ USER DASHBOARD ============

// Get User Dashboard Data
app.get('/api/dashboard', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    // Get enrolled courses with progress
    db.all(`
        SELECT c.id, c.name, c.description, c.course_key, c.price, e.progress, e.enrolled_at
        FROM enrollments e
        JOIN courses c ON e.course_id = c.id
        WHERE e.user_id = ?
    `, [userId], (err, courses) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({
            user: req.user,
            courses: courses,
            progress: courses.map(c => ({
                course_name: c.name,
                progress: c.progress,
                course_key: c.course_key
            }))
        });
    });
});

// Update Course Progress
app.post('/api/progress', authenticateToken, (req, res) => {
    const { course_key, progress } = req.body;
    const userId = req.user.id;
    
    db.get('SELECT id FROM courses WHERE course_key = ?', [course_key], (err, course) => {
        if (err || !course) {
            return res.status(404).json({ error: 'Course not found' });
        }
        
        db.run(
            'UPDATE enrollments SET progress = ? WHERE user_id = ? AND course_id = ?',
            [progress, userId, course.id],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Failed to update progress' });
                }
                
                res.json({ success: true, progress });
            }
        );
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`💰 Razorpay Test Mode Active`);
    console.log(`📝 Test Card: 4242 4242 4242 4242`);
    console.log(`🔑 Key ID: rzp_test_SdoHI00hjGMUoA`);
});