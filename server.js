import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Dynamic import models
let User, Profile, Like;

async function loadModels() {
    const UserSchema = (await import('./models/User.js')).default;
    const ProfileSchema = (await import('./models/Profile.js')).default;
    const LikeSchema = (await import('./models/Like.js')).default;

    User = mongoose.model('User', UserSchema);
    Profile = mongoose.model('Profile', ProfileSchema);
    Like = mongoose.model('Like', LikeSchema);
}

// Auth middleware
const auth = (req, res, next) => {
    const token = req.header('x-auth-token');
    if (!token) return res.status(401).json({ message: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded.user;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid token' });
    }
};

// Routes
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        await loadModels();
        let user = await User.findOne({ email });
        if (user) return res.status(400).json({ message: 'User exists' });

        user = new User({ email, password });
        await user.save();

        const token = jwt.sign({ user: { id: user.id } }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (err) {
        res.status(500).send('Server error');
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        await loadModels();
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        const isMatch = await user.matchPassword(password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        const token = jwt.sign({ user: { id: user.id } }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (err) {
        res.status(500).send('Server error');
    }
});

// Generate synthetic profiles
app.get('/api/generate-profiles', auth, async (req, res) => {
    try {
        await loadModels();
        const { generateAndSaveSyntheticProfile } = await import('./generators/synthetic.js');
        const count = parseInt(req.query.count) || 5;
        const limit = Math.min(count, 10);
        const profiles = [];
        for (let i = 0; i < limit; i++) {
            const p = await generateAndSaveSyntheticProfile(req.user.id);
            profiles.push(p);
        }
        res.json(profiles);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to generate profiles' });
    }
});

// Like route
app.post('/api/like', auth, async (req, res) => {
    const { profileId, liked } = req.body;
    try {
        await loadModels();
        let like = await Like.findOne({ userId: req.user.id, profileId });
        if (like) like.liked = liked;
        else like = new Like({ userId: req.user.id, profileId, liked });
        await like.save();

        let match = null;
        if (liked) {
            const targetProfile = await Profile.findById(profileId).select('ownerId name imageUrl');
            if (targetProfile) {
                const myProfile = await Profile.findOne({ ownerId: req.user.id });
                const mutual = await Like.findOne({
                    userId: targetProfile.ownerId,
                    profileId: myProfile?._id,
                    liked: true
                });
                if (mutual) {
                    match = { with: targetProfile.name, photo: targetProfile.imageUrl };
                }
            }
        }
        res.json({ success: true, match });
    } catch (err) {
        res.status(500).json({ message: 'Error liking profile' });
    }
});

// Socket.IO
const userSocketMap = {};
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Auth required"));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.user.id;
        next();
    } catch (err) {
        next(new Error("Invalid token"));
    }
});

io.on('connection', (socket) => {
    userSocketMap[socket.userId] = socket.id;
    socket.on('send_message', (data) => {
        const recipientSocket = userSocketMap[data.to];
        if (recipientSocket) {
            io.to(recipientSocket).emit('receive_message', {
                from: socket.userId,
                message: data.message,
                timestamp: new Date()
            });
        }
    });
    socket.on('disconnect', () => delete userSocketMap[socket.userId]);
});

// Start server
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        await loadModels();
        const PORT = process.env.PORT || 5000;
        httpServer.listen(PORT, '0.0.0.0', () => {
            console.log(\`🚀 Server running on http://localhost:\${PORT}\`);
        });
    })
    .catch(err => console.log(err));
