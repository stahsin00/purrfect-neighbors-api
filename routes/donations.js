import express from "express";

import { isAuthenticated } from "../middleware/middleware.js";
import { db } from "../services/mysql.js";
import redisClient, { scanKeys } from "../services/redis.js";
import { getPlaceName } from "../utils/geocoding.js";

const router = express.Router();

router.post("/create", isAuthenticated, async (req, res) => {
  const { title, description, latitude, longitude } = req.body;

  if (!title || !description || !latitude || !longitude) {
    return res.status(400).send("Missing required fields.");
  }

  try {
    const placeName = await getPlaceName(longitude, latitude);

    const result = await db.query(
      "INSERT INTO posts (user_id, title, content, post_address, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, title, description, placeName, latitude, longitude]
    );

    const cacheKey = `user:${req.user.id}:posts`;
    await redisClient.del(cacheKey);

    // Clear search cache
    const pattern = `search:products:*:*:*:*:*:*`;
    const keys = await scanKeys(pattern);
    keys.forEach((key) => {
      redisClient.del(key);
    });

    res.status(201).send({ postId: result.insertId });
  } catch (err) {
    console.error(err);

    if (err.message === "Geocoding failed.") {
      return res.status(400).send("Invalid coordinates.");
    }

    res.status(500).send("Internal Server Error");
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const cacheKey = `post:${id}`;
    const cachedPost = await redisClient.get(cacheKey);

    if (cachedPost) {
      return res.status(200).json(JSON.parse(cachedPost));
    }

    const postResult = await db.query("SELECT * FROM posts WHERE id = ?", [id]);
    if (postResult.length === 0) {
      return res.status(404).send("Post not found.");
    }

    const post = postResult[0];

    const userResult = await db.query("SELECT name FROM users WHERE id = ?", [
      post.user_id
    ]);
    if (userResult.length === 0) {
      return res.status(404).send("User not found.");
    }

    const user = userResult[0];

    const commentsResult = await db.query(
      "SELECT comments.*, users.name as commentBy FROM comments JOIN users ON comments.user_id = users.id WHERE post_id = ? ORDER BY comments.created_at",
      [id]
    );
    const formattedComments = commentsResult.map((comment) => ({
      id: comment.id,
      commentBy: comment.commentBy,
      commentDate: comment.created_at,
      content: comment.content
    }));

    let location = post.post_address;
    if (!location) {
      try {
        location = await getPlaceName(post.longitude, post.latitude);
        await db.query("UPDATE posts SET post_address = ? WHERE id = ?", [
          location,
          id
        ]);
      } catch (err) {
        console.error(err);
        location = "Unknown Location";
      }
    }

    const formattedPost = {
      id: post.id,
      title: post.title,
      description: post.content,
      postBy: user.name,
      postDate: post.created_at,
      location: location,
      latitude: post.latitude,
      longitude: post.longitude,
      comments: formattedComments
    };

    await redisClient.set(cacheKey, JSON.stringify(formattedPost), "EX", 3600);

    res.status(200).json(formattedPost);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/:id/comments", isAuthenticated, async (req, res) => {
  const { id: post_id } = req.params;
  const { content } = req.body;

  if (!content) {
    return res.status(400).send("Content is required.");
  }

  try {
    const result = await db.query(
      "INSERT INTO comments (user_id, post_id, content) VALUES (?, ?, ?)",
      [req.user.id, post_id, content]
    );

    let cacheKey = `post:${post_id}`;
    await redisClient.del(cacheKey);

    cacheKey = `user:${req.user.id}:comments`;
    await redisClient.del(cacheKey);

    res.status(201).send({ commentId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

export default router;
