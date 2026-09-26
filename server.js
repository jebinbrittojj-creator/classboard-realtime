const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// SQLite Database Setup
const db = new sqlite3.Database('classboard.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('SQLite database connected');
});

// Initialize Database Tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacherId INTEGER,
    name TEXT,
    code TEXT UNIQUE,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teacherId) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    classId INTEGER,
    email TEXT,
    name TEXT,
    score REAL DEFAULT 0,
    attendance REAL DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(classId) REFERENCES classes(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    studentId INTEGER,
    classId INTEGER,
    score REAL,
    feedback TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(studentId) REFERENCES students(id),
    FOREIGN KEY(classId) REFERENCES classes(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    studentId INTEGER,
    classId INTEGER,
    date TEXT,
    present BOOLEAN,
    FOREIGN KEY(studentId) REFERENCES students(id),
    FOREIGN KEY(classId) REFERENCES classes(id)
  )`);
});

// Helper Functions
const getAsync = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const allAsync = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
};

const runAsync = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await runAsync(
      'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
      [email, hashedPassword, role || 'teacher']
    );

    const token = jwt.sign({ id: result.id, email, role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: result.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getAsync('SELECT * FROM users WHERE email = ?', [email]);

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: user.id, role: user.role });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// Class Routes
app.post('/api/classes', verifyToken, async (req, res) => {
  try {
    const { name } = req.body;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();

    const result = await runAsync(
      'INSERT INTO classes (teacherId, name, code) VALUES (?, ?, ?)',
      [req.user.id, name, code]
    );

    res.json({ id: result.id, code });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/classes/:classId', verifyToken, async (req, res) => {
  try {
    const classData = await getAsync('SELECT * FROM classes WHERE id = ?', [req.params.classId]);
    const students = await allAsync('SELECT * FROM students WHERE classId = ?', [req.params.classId]);

    res.json({ ...classData, students });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/classes', verifyToken, async (req, res) => {
  try {
    const classes = await allAsync('SELECT * FROM classes WHERE teacherId = ?', [req.user.id]);
    res.json(classes);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Student Routes
app.post('/api/classes/:classId/students', verifyToken, async (req, res) => {
  try {
    const { email, name } = req.body;

    const result = await runAsync(
      'INSERT INTO students (classId, email, name, score, attendance) VALUES (?, ?, ?, ?, ?)',
      [req.params.classId, email, name, 0, 0]
    );

    io.emit('student_added', { classId: req.params.classId, student: { id: result.id, email, name } });
    res.json({ id: result.id, email, name });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/classes/:classId/students', async (req, res) => {
  try {
    const students = await allAsync('SELECT * FROM students WHERE classId = ?', [req.params.classId]);
    res.json(students);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/students/:studentId', verifyToken, async (req, res) => {
  try {
    const student = await getAsync('SELECT classId FROM students WHERE id = ?', [req.params.studentId]);
    await runAsync('DELETE FROM students WHERE id = ?', [req.params.studentId]);

    io.emit('student_removed', { classId: student.classId, studentId: req.params.studentId });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Grading Routes
app.post('/api/students/:studentId/grade', verifyToken, async (req, res) => {
  try {
    const { score, feedback, classId } = req.body;

    const result = await runAsync(
      'INSERT INTO grades (studentId, classId, score, feedback) VALUES (?, ?, ?, ?)',
      [req.params.studentId, classId, score, feedback]
    );

    const student = await getAsync('SELECT * FROM students WHERE id = ?', [req.params.studentId]);
    const avgScore = await getAsync(
      'SELECT AVG(score) as avgScore FROM grades WHERE studentId = ?',
      [req.params.studentId]
    );

    await runAsync('UPDATE students SET score = ? WHERE id = ?', [avgScore.avgScore, req.params.studentId]);

    io.emit('grade_updated', { classId, studentId: req.params.studentId, score: avgScore.avgScore, feedback });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Attendance Routes
app.post('/api/students/:studentId/attendance', verifyToken, async (req, res) => {
  try {
    const { classId, present, date } = req.body;
    const today = date || new Date().toISOString().split('T')[0];

    const existing = await getAsync(
      'SELECT id FROM attendance WHERE studentId = ? AND date = ? AND classId = ?',
      [req.params.studentId, today, classId]
    );

    if (existing) {
      await runAsync('UPDATE attendance SET present = ? WHERE id = ?', [present, existing.id]);
    } else {
      await runAsync(
        'INSERT INTO attendance (studentId, classId, date, present) VALUES (?, ?, ?, ?)',
        [req.params.studentId, classId, today, present]
      );
    }

    const attendanceCount = await getAsync(
      'SELECT COUNT(*) as present FROM attendance WHERE studentId = ? AND present = 1',
      [req.params.studentId]
    );
    const totalCount = await getAsync(
      'SELECT COUNT(*) as total FROM attendance WHERE studentId = ?',
      [req.params.studentId]
    );

    const attendancePercent = totalCount.total > 0 ? (attendanceCount.present / totalCount.total) * 100 : 0;
    await runAsync('UPDATE students SET attendance = ? WHERE id = ?', [attendancePercent, req.params.studentId]);

    io.emit('attendance_updated', { classId, studentId: req.params.studentId, attendance: attendancePercent });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Analytics Routes
app.get('/api/classes/:classId/analytics', async (req, res) => {
  try {
    const students = await allAsync('SELECT * FROM students WHERE classId = ?', [req.params.classId]);

    const avgScore = students.length > 0
      ? students.reduce((sum, s) => sum + s.score, 0) / students.length
      : 0;

    const avgAttendance = students.length > 0
      ? students.reduce((sum, s) => sum + s.attendance, 0) / students.length
      : 0;

    res.json({
      totalStudents: students.length,
      avgScore: Math.round(avgScore),
      avgAttendance: Math.round(avgAttendance),
      students
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// WebSocket Events
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_class', (classId) => {
    socket.join(`class_${classId}`);
    io.to(`class_${classId}`).emit('user_joined', { count: io.of('/').sockets.size });
  });

  socket.on('grade_submitted', (data) => {
    io.to(`class_${data.classId}`).emit('grade_updated', data);
  });

  socket.on('attendance_marked', (data) => {
    io.to(`class_${data.classId}`).emit('attendance_updated', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Export Data Routes
app.get('/api/classes/:classId/export/csv', async (req, res) => {
  try {
    const students = await allAsync('SELECT * FROM students WHERE classId = ?', [req.params.classId]);

    let csv = 'Name,Email,Score,Attendance\n';
    students.forEach(s => {
      csv += `${s.name},${s.email},${s.score},${s.attendance}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="classboard-export.csv"');
    res.send(csv);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/classes/:classId/export/json', async (req, res) => {
  try {
    const classData = await getAsync('SELECT * FROM classes WHERE id = ?', [req.params.classId]);
    const students = await allAsync('SELECT * FROM students WHERE classId = ?', [req.params.classId]);

    res.json({ class: classData, students });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
