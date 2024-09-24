import express from "express";
import multer from "multer";

import { isAuthenticated } from "../middleware/middleware.js";
import { db } from "../services/mysql.js";
import redisClient, { scanKeys } from "../services/redis.js";
import { UploadImage } from "../services/s3.js";
import { getPlaceName } from "../utils/geocoding.js";

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/create", isAuthenticated, async (req, res) => {
  const { name, description, latitude, longitude, imageUrl, type, breed, age } =
    req.body;

  if (!name || !description || !latitude || !longitude || !imageUrl) {
    return res.status(400).send("Missing required fields.");
  }

  try {
    const placeName = await getPlaceName(longitude, latitude);

    const result = await db.query(
      "INSERT INTO pets (user_id, pet_name, pet_description, pet_address, latitude, longitude, pet_type, breed, age) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        req.user.id,
        name,
        description,
        placeName,
        latitude,
        longitude,
        type || null,
        breed || null,
        age || null
      ]
    );

    await db.query("INSERT INTO pet_photos (pet_id, photo_url) VALUES (?, ?)", [
      result.insertId,
      imageUrl
    ]);

    // Clear search cache
    const pattern = `search:pets:*:*:*:*:*:*`;
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

router.post(
  "/upload",
  isAuthenticated,
  upload.single("file"),
  async (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).send("No file uploaded.");
    }

    try {
      const location = await UploadImage(file);
      res.status(200).send(location);
    } catch (err) {
      console.error(err);
      res.status(500).send("Internal Server Error");
    }
  }
);

router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const cacheKey = `pet:${id}`;
    const cachedPet = await redisClient.get(cacheKey);

    if (cachedPet) {
      return res.status(200).json(JSON.parse(cachedPet));
    }

    const petResult = await db.query("SELECT * FROM pets WHERE id = ?", [id]);
    if (petResult.length === 0) {
      return res.status(404).send("Pet not found.");
    }

    const pet = petResult[0];

    const userResult = await db.query("SELECT * FROM users WHERE id = ?", [
      pet.user_id
    ]);
    if (userResult.length === 0) {
      return res.status(404).send("User not found.");
    }

    const user = userResult[0];

    const imageUrlResult = await db.query(
      "SELECT * FROM pet_photos WHERE pet_id = ?",
      [id]
    );
    const imageUrl =
      imageUrlResult.length > 0 ? imageUrlResult[0].photo_url : null;

    let location = pet.pet_address;
    if (!location) {
      try {
        location = await getPlaceName(pet.longitude, pet.latitude);
        await db.query("UPDATE pets SET pet_address = ? WHERE id = ?", [
          location,
          id
        ]);
      } catch (err) {
        console.error(err);
        location = "Unknown Location";
      }
    }

    const formattedPet = {
      id: pet.id,
      name: pet.pet_name,
      description: pet.pet_description,
      image: imageUrl,
      contact: {
        name: user.name,
        email: user.email
      },
      postDate: pet.created_at,
      location: location,
      latitude: pet.latitude,
      longitude: pet.longitude,
      type: pet.pet_type,
      breed: pet.breed,
      age: pet.age
    };

    await redisClient.set(cacheKey, JSON.stringify(formattedPet), "EX", 3600);

    res.status(200).json(formattedPet);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

export default router;
