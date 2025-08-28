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

// Retryable download
async function downloadFile(url, dir, filename, retries = 2) {
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) return filePath;

  try {
    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url, method: "GET", responseType: "stream" });
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => resolve(filePath));
      writer.on("error", reject);
    });
  } catch (err) {
    if (retries > 0) {
      console.warn(`Retrying download for ${filename}...`);
      return downloadFile(url, dir, filename, retries - 1);
    }
    console.error(`Failed to download ${url}:`, err.message);
    return null;
  }
}

// Generate short GIF preview from video
async function generateGIF(videoPath, gifPath) {
  return new Promise((resolve) => {
    exec(`ffmpeg -y -i "${videoPath}" -ss 0 -t 3 -vf "fps=10,scale=320:-1:flags=lanczos" "${gifPath}"`, error => {
      if (error) {
        console.warn(`GIF generation failed for ${videoPath}. Using thumbnail instead.`);
        resolve(null); // fallback to thumbnail
      } else resolve(gifPath);
    });
  });
}

// Generate EPUB cover
async function generateCover(title = TITLE, author = AUTHOR) {
  const thumbs = fs.readdirSync(THUMB_DIR).filter(f => f.endsWith(".jpg"));

  const cols = Math.min(3, thumbs.length || 1);
  const rows = Math.ceil((thumbs.length || 1) / cols);
  const thumbWidth = 300;
  const thumbHeight = 200;
  const canvasWidth = cols * thumbWidth + 100;
  const canvasHeight = 400 + rows * thumbHeight;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Title & Author
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 80px Sans";
  ctx.textAlign = "center";
  ctx.fillText(title, canvasWidth / 2, 100);
  ctx.font = "bold 50px Sans";
  ctx.fillText(author, canvasWidth / 2, 180);

  const xOffset = 50;
  const yOffset = 220;
  for (let i = 0; i < thumbs.length; i++) {
    try {
      const img = await loadImage(path.join(THUMB_DIR, thumbs[i]));
      const x = xOffset + (i % cols) * thumbWidth;
      const y = yOffset + Math.floor(i / cols) * thumbHeight;
      ctx.drawImage(img, x, y, thumbWidth, thumbHeight);
    } catch (e) {
      console.warn(`Failed to load thumbnail ${thumbs[i]} for cover:`, e.message);
    }
  }

  fs.writeFileSync(COVER_PATH, canvas.toBuffer("image/jpeg"));
  console.log("Cover image generated:", COVER_PATH);
}

// Fetch video posts from Facebook Graph API
async function fetchVideoPosts() {
  try {
    const url = `https://graph.facebook.com/v23.0/${PAGE_ID}/posts`;
    const params = {
      fields: 'message,created_time,attachments{media,type,url,subattachments}',
      since: SINCE,
      until: UNTIL,
      access_token: ACCESS_TOKEN
    };

    const res = await axios.get(url, { params });
    const posts = res.data.data || [];
    return posts.filter(post =>
      post.attachments?.data.some(att =>
        att.type === "video_inline" || att.type === "video" ||
        (att.subattachments?.data.some(sub => sub.type === "video_inline" || sub.type === "video"))
      )
    );
  } catch (err) {
    console.error("Error fetching posts:", err.response?.data || err.message);
    return [];
  }
}

// ---------------- MAIN WORKFLOW ----------------
(async () => {
  try {
    // Check ffmpeg
    exec("ffmpeg -version", (err) => {
      if (err) throw new Error("ffmpeg not found. Please install ffmpeg.");
    });

    console.log("Fetching video posts...");
    const posts = await fetchVideoPosts();
    if (!posts.length) return console.log("No video posts found in this date range.");
    console.log(`Found ${posts.length} video posts.`);

    const content = [];

    for (const post of posts) {
      const postDate = new Date(post.created_time).toDateString();
      let html = `<div style="padding:10px;">
                    <h2 id="${post.id}" style="font-size:1.2em; margin-bottom:5px;">${postDate}</h2>
                    <p style="font-size:1em; line-height:1.4;">${post.message || ""}</p>`;

      const attachments = post.attachments.data.flatMap(att => att.subattachments?.data || [att]);

      for (const att of attachments) {
        if (att.type === "video_inline" || att.type === "video") {
          const videoFile = `${post.id}.mp4`;
          const videoPath = await downloadFile(att.url, VIDEO_DIR, videoFile);
          if (!videoPath) continue;

          const thumbUrl = att.media?.image?.src;
          let thumbFile = null;
          if (thumbUrl) {
            thumbFile = `${post.id}.jpg`;
            const downloadedThumb = await downloadFile(thumbUrl, THUMB_DIR, thumbFile);
            if (!downloadedThumb) thumbFile = null;
          }

          const gifFile = `${post.id}.gif`;
          const gifPath = path.join(GIF_DIR, gifFile);
          const generatedGIF = await generateGIF(videoPath, gifPath);

          const fbVideoUrl = `https://www.facebook.com/${PAGE_ID}/videos/${post.id}`;
          if (generatedGIF) {
            html += `<p style="text-align:center;">
                       <a href="${fbVideoUrl}" target="_blank">
                         <img src="gifs/${gifFile}" style="max-width:100%; height:auto;" alt="Video preview of post on ${postDate}"/>
                       </a>
                     </p>`;
          } else if (thumbFile) {
            html += `<p style="text-align:center;">
                       <a href="${fbVideoUrl}" target="_blank">
                         <img src="thumbnails/${thumbFile}" style="max-width:100%; height:auto;" alt="Video thumbnail of post on ${postDate}"/>
                       </a>
                     </p>`;
          }
        }
      }

      html += `</div>`;
      content.push({ title: postDate, data: html });
      console.log(`Processed post: ${post.id}`);
    }

    await generateCover();

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
