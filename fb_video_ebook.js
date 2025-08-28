import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import Epub from "epub-gen";

// ---------------- CONFIG ----------------
const PAGE_ID = process.env.PAGE_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SINCE = process.env.SINCE;
const UNTIL = process.env.UNTIL;
const AUTHOR = process.env.AUTHOR;
const TITLE = process.env.TITLE;

// ---------------- FOLDERS ----------------
const ASSETS_DIR = path.join(process.cwd(), "ebook_assets");
const VIDEO_DIR = path.join(ASSETS_DIR, "videos");
const GIF_DIR = path.join(ASSETS_DIR, "gifs");
const THUMB_DIR = path.join(ASSETS_DIR, "thumbnails");
[ASSETS_DIR, VIDEO_DIR, GIF_DIR, THUMB_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
const COVER_PATH = path.join(ASSETS_DIR, "cover.jpg");

// ---------------- HELPERS ----------------
async function fetchVideoPosts() {
  const url = `https://graph.facebook.com/v23.0/${PAGE_ID}/posts?fields=message,created_time,attachments{media,type,url}&since=${SINCE}&until=${UNTIL}&access_token=${ACCESS_TOKEN}`;
  const response = await axios.get(url);
  const posts = response.data.data;

  return posts.filter(post =>
    post.attachments?.data.some(att => att.type === "video_inline" || att.type === "video")
  );
}

async function downloadFile(url, dir, filename) {
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) return filePath;

  const writer = fs.createWriteStream(filePath);
  const response = await axios({ url, method: "GET", responseType: "stream" });
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(filePath));
    writer.on("error", reject);
  });
}

async function generateGIF(videoPath, gifPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -ss 0 -t 3 -vf "fps=10,scale=320:-1:flags=lanczos" "${gifPath}"`;
    exec(cmd, (error) => {
      if (error) reject(error);
      else resolve(gifPath);
    });
  });
}

// Generate cover image with collage
async function generateCover(title = TITLE, author = AUTHOR) {
  const canvasWidth = 1200;
  const canvasHeight = 1600;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Title
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 80px Sans";
  ctx.textAlign = "center";
  ctx.fillText(title, canvasWidth / 2, 150);

  // Author
  ctx.font = "bold 50px Sans";
  ctx.fillText(author, canvasWidth / 2, 230);

  // Load thumbnails for collage (max 6)
  const thumbs = fs.readdirSync(THUMB_DIR).filter(f => f.endsWith(".jpg")).slice(0, 6);
  const cols = 3;
  const rows = Math.ceil(thumbs.length / cols);
  const thumbWidth = 300;
  const thumbHeight = 200;
  const xOffset = (canvasWidth - cols * thumbWidth) / 2;
  const yOffset = 300;

  for (let i = 0; i < thumbs.length; i++) {
    const img = await loadImage(path.join(THUMB_DIR, thumbs[i]));
    const x = xOffset + (i % cols) * thumbWidth;
    const y = yOffset + Math.floor(i / cols) * thumbHeight;
    ctx.drawImage(img, x, y, thumbWidth, thumbHeight);
  }

  const buffer = canvas.toBuffer("image/jpeg");
  fs.writeFileSync(COVER_PATH, buffer);
  console.log("Cover image generated:", COVER_PATH);
}

// ---------------- MAIN WORKFLOW ----------------
(async () => {
  try {
    console.log("Fetching video posts...");
    const posts = await fetchVideoPosts();

    if (!posts.length) {
      console.log("No video posts found in this date range.");
      return;
    }

    console.log(`Found ${posts.length} video posts.`);

    const content = [];

    for (const post of posts) {
      const postDate = new Date(post.created_time).toDateString();
      let html = `<div style="padding:10px;">
                    <h2 id="${post.id}" style="font-size:1.2em; margin-bottom:5px;">${postDate}</h2>
                    <p style="font-size:1em; line-height:1.4;">${post.message || ""}</p>`;

      for (const att of post.attachments.data) {
        if (att.type === "video_inline" || att.type === "video") {
          // Download video
          const videoFile = `${post.id}.mp4`;
          const videoPath = await downloadFile(att.url, VIDEO_DIR, videoFile);

          // Download thumbnail
          const thumbUrl = att.media?.image?.src;
          if (thumbUrl) {
            const thumbFile = `${post.id}.jpg`;
            await downloadFile(thumbUrl, THUMB_DIR, thumbFile);
          }

          // Generate GIF preview
          const gifFile = `${post.id}.gif`;
          const gifPath = path.join(GIF_DIR, gifFile);
          await generateGIF(videoPath, gifPath);

          // Link GIF to Facebook video
          const fbVideoUrl = `https://www.facebook.com/${PAGE_ID}/videos/${post.id}`;
          html += `<p style="text-align:center;">
                     <a href="${fbVideoUrl}" target="_blank">
                       <img src="gifs/${gifFile}" style="max-width:100%; height:auto;" alt="Video preview of post on ${postDate}"/>
                     </a>
                   </p>`;
        }
      }

      html += `</div>`;
      content.push({ title: postDate, data: html });
    }

    // Generate cover
    await generateCover();

    // Generate EPUB
    const option = {
      title: TITLE,
      author: AUTHOR,
      cover: COVER_PATH,
      output: "Facebook_Video_Posts.epub",
      content,
      appendChapterTitles: true
    };

    await new Epub(option).promise;
    console.log("EPUB generated successfully with cover, GIF previews, TOC, and video links!");
  } catch (err) {
    console.error("Error:", err);
  }
})();
