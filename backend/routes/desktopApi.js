import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Ephemeral in-memory store for live status — no persistence needed
const liveStatusMap = new Map();

function requireDesktopAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.desktopUser = jwt.verify(auth.slice(7), process.env.DESKTOP_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Receives the pg Pool instance from index.js to avoid circular imports
export default function desktopApiRouter(pool) {
  const router = Router();

  // POST /api/desktop/auth/login
  router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT id, username, password, role FROM users WHERE username = $1',
        [username]
      );
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      if (user.role !== 'model') {
        return res.status(403).json({ error: 'Account not authorised for desktop app' });
      }
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign(
        { userId: user.id, username: user.username, role: user.role },
        process.env.DESKTOP_JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ token });
    } catch (err) {
      console.error('[desktop/auth/login]', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/desktop/stream-config
  router.get('/stream-config', requireDesktopAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT name,
                rtmp_url   AS "rtmpUrl",
                stream_key AS "streamKey"
         FROM stream_destinations
         WHERE user_id = $1
         ORDER BY id`,
        [req.desktopUser.userId]
      );
      res.json({
        siteRtmpUrl: process.env.SITE_RTMP_URL || '',
        destinations: rows,
      });
    } catch (err) {
      console.error('[desktop/stream-config]', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/desktop/status
  router.post('/status', requireDesktopAuth, (req, res) => {
    const { live, platforms, bitrate, droppedFrames } = req.body;
    liveStatusMap.set(req.desktopUser.userId, {
      live: Boolean(live),
      platforms: Array.isArray(platforms) ? platforms : [],
      bitrate: Number(bitrate) || 0,
      droppedFrames: Number(droppedFrames) || 0,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // GET /api/desktop/destinations  (returns full objects including id)
  router.get('/destinations', requireDesktopAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, rtmp_url AS "rtmpUrl", stream_key AS "streamKey"
         FROM stream_destinations
         WHERE user_id = $1
         ORDER BY id`,
        [req.desktopUser.userId]
      );
      res.json({ destinations: rows });
    } catch (err) {
      console.error('[desktop/destinations GET]', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /api/desktop/destinations
  router.post('/destinations', requireDesktopAuth, async (req, res) => {
    const { name, rtmpUrl, streamKey } = req.body;
    if (!name || !rtmpUrl || !streamKey) {
      return res.status(400).json({ error: 'name, rtmpUrl, and streamKey are required' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO stream_destinations (user_id, name, rtmp_url, stream_key)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, rtmp_url AS "rtmpUrl", stream_key AS "streamKey"`,
        [req.desktopUser.userId, name.trim(), rtmpUrl.trim(), streamKey.trim()]
      );
      res.json({ ok: true, destination: rows[0] });
    } catch (err) {
      console.error('[desktop/destinations POST]', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // DELETE /api/desktop/destinations/:id
  router.delete('/destinations/:id', requireDesktopAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM stream_destinations WHERE id = $1 AND user_id = $2',
        [id, req.desktopUser.userId]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Not found or not yours' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[desktop/destinations DELETE]', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/desktop/app-version  (no auth — checked before app login)
  router.get('/app-version', (_req, res) => {
    res.json({ version: process.env.APP_VERSION || '1.0.0' });
  });

  return router;
}
