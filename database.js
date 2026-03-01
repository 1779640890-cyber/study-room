const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.NODE_ENV === 'production' 
  ? '/data/studyroom.db' 
  : path.join(__dirname, 'studyroom.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err);
  } else {
    console.log('数据库连接成功:', dbPath);
  }
});

function initTables() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          nickname TEXT,
          avatar TEXT DEFAULT '📚',
          total_study_time INTEGER DEFAULT 0,
          study_days INTEGER DEFAULT 0,
          weekly_data TEXT DEFAULT '[0,0,0,0,0,0,0]',
          last_study_date TEXT,
          created_at INTEGER
        )
      `, (err) => {
        if (err) console.error('创建 users 表失败:', err);
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'public',
          password TEXT,
          max_members INTEGER DEFAULT 20,
          tags TEXT DEFAULT '[]',
          created_at INTEGER,
          created_by TEXT
        )
      `, (err) => {
        if (err) console.error('创建 rooms 表失败:', err);
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          completed INTEGER DEFAULT 0,
          created_at INTEGER,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `, (err) => {
        if (err) {
          console.error('创建 tasks 表失败:', err);
          reject(err);
        } else {
          console.log('数据库表初始化完成');
          resolve();
        }
      });
    });
  });
}

const dbAsync = {
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }
};

module.exports = { db, dbAsync, initTables };
