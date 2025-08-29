import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import fs from "fs-extra";
import path from "path";
import { exec } from "child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import Epub from "epub-gen";

// ---------------- CONFIG ----------------
const PAGE_ID = process.env.FB_PAGE_ID;
const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const SINCE = process.env.SINCE;
const UNTIL = process.env.UNTIL;
const AUTHOR = process.env.AUTHOR;
const TITLE = process.env.TITLE;
const OUTPUT_EPUB = process.env.OUTPUT_EPUB || "Facebook_Video_Posts.epub";

if (!PAGE_ID || !ACCESS_TOKEN) {
  console.error("⚠️ Missing FB_PAGE_ID or FB_ACCESS_TOKEN in .env");
  process.exit(1);
}

// ---------------- FOLDERS ----------------
const ASSETS_DIR = path.join(process.cwd(), "ebook_assets");
const VIDEO_DIR = path.join(ASSETS_DIR, "videos");
const GIF_DIR = path.join(ASSETS_DIR, "gifs");
const THUMB_DIR = path.join(ASSETS_DIR, "thumbnails");

[ASSETS_DIR, VIDEO_DIR, GIF_DIR, THUMB_DIR].forEach(dir => fs.ensureDirSync(dir));

const COVER_PATH = path.join(ASSETS_DIR, "cover.jpg");
const PROCESSED_FILE = path.join(ASSETS_DIR, "processed.json");
let processedPosts = fs.existsSync(PROCESSED_FILE) ? JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf-8")) : [];

// ---------------- HASHTAGS ----------------
const HASHTAGS = [
  "#AfricanHeritage", "#Artifacts", "#Culture",
  "#TraditionalArt", "#Educational", "#CulturalPreservation",
  "#ArtHistory", "#HeritageEducation", "#LearnCulture"
];

// ---------------- HELPERS ----------------
async function downloadFile(url, dir, filename, retries = 2) {
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) return filePath;

  try {
    const writer = fs.createWriteStream(filePath);
    const response = await axios.get(url, { responseType: "stream" });
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

async function generateGIF(videoPath, gifPath) {
  return new Promise(resolve => {
    exec(`ffmpeg -y -i "${videoPath}" -ss 0 -t 3 -vf "fps=10,scale=320:-1:flags=lanczos" "${gifPath}"`, error => {
      if (error) {
        console.warn(`GIF generation failed for ${videoPath}. Using thumbnail instead.`);
        resolve(null);
      } else resolve(gifPath);
    });
  });
}

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
      const imgPath = path.join(THUMB_DIR, thumbs[i]);
      if (fs.existsSync(imgPath)) {
        const img = await loadImage(imgPath);
        const x = xOffset + (i % cols) * thumbWidth;
        const y = yOffset + Math.floor(i / cols) * thumbHeight;
        ctx.drawImage(img, x, y, thumbWidth, thumbHeight);
      }
    } catch (e) {
      console.warn(`Failed to load thumbnail ${thumbs[i]} for cover:`, e.message);
    }
  }

  fs.writeFileSync(COVER_PATH, canvas.toBuffer("image/jpeg"));
  console.log("📘 Cover image generated:", COVER_PATH);
}

function formatPostForEPUB(post, thumbnailFile, hashtagIndex = 0) {
  const { id, created_time, message } = post;
  const videoLink = `https://www.facebook.com/${PAGE_ID}/videos/${id}`;
  const description = message || "Shared respectfully for cultural education, insight, and appreciation of heritage artifacts.";

  const hashtags = HASHTAGS[hashtagIndex % HASHTAGS.length];

  return {
    title: new Date(created_time).toDateString(),
    data: `
      <h1>${new Date(created_time).toDateString()}</h1>
      <p style="text-align:center;">
        <a href="${videoLink}" target="_blank">
          <img src="${thumbnailFile}" alt="Video thumbnail" style="max-width:100%; height:auto; border:1px solid #ccc;"/>
        </a>
      </p>
      <p>${description}</p>
      <h3>Educational Insights:</h3>
      <p>Explore the cultural significance, historical context, and artistic mastery of this artifact.</p>
      <h3>Social & Cultural Impact:</h3>
      <p>Learn how this artifact influences identity, inspires creativity, and connects past practices with modern interpretations.</p>
      <h3>Visual Notes:</h3>
      <p>Notice design elements, colors, motifs, and symbolic forms that reflect cultural values and artistic skill.</p>
      <p>🔗 Original Video: <a href="${videoLink}" target="_blank">Watch on Facebook</a></p>
      <p>Hashtags: ${hashtags}</p>
    `
  };
}

async function fetchFacebookPosts(limit = 50) {
  let allPosts = [];
  let nextUrl = `https://graph.facebook.com/v23.0/${PAGE_ID}/posts?fields=id,message,created_time,attachments{media,type,url,subattachments}&since=${SINCE}&until=${UNTIL}&limit=${limit}&access_token=${ACCESS_TOKEN}`;

  try {
    while (nextUrl) {
      console.log("📡 Fetching:", nextUrl);
      const res = await axios.get(nextUrl);
      const { data, paging } = res.data;

      if (data && data.length > 0) {
        const videoPosts = data.filter(post =>
          post.attachments?.data.some(att =>
            att.type === "video_inline" || att.type === "video" ||
            (att.subattachments?.data.some(sub => sub.type === "video_inline" || sub.type === "video"))
          )
        );
        allPosts = allPosts.concat(videoPosts);
      }

      nextUrl = paging?.next || null;
    }

    console.log(`✅ Total video posts fetched: ${allPosts.length}`);
    return allPosts;
  } catch (err) {
    console.error("❌ Error fetching posts:", err.response?.data || err.message);
    return allPosts;
  }
}

// ---------------- MAIN ----------------
(async () => {
  try {
    exec("ffmpeg -version", (err) => {
      if (err) throw new Error("ffmpeg not found. Please install ffmpeg.");
    });

    const posts = await fetchFacebookPosts();
    if (!posts.length) return console.log("No video posts found in this date range.");

    const epubChapters = [];
    const previewLinks = [];

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      if (processedPosts.includes(post.id)) {
        console.log(`⚠️ Skipping already processed post: ${post.id}`);
        continue;
      }

      const attachments = post.attachments.data.flatMap(att => att.subattachments?.data || [att]);
      let thumbnailFile = "default-thumbnail.jpeg";

      for (const att of attachments) {
        if (att.type === "video_inline" || att.type === "video") {
          const videoFile = `${post.id}.mp4`;
          const videoPath = await downloadFile(att.url, VIDEO_DIR, videoFile);

          if (!videoPath) continue;

          const thumbUrl = att.media?.image?.src;
          if (thumbUrl) {
            const thumbFile = `${post.id}.jpg`;
            thumbnailFile = await downloadFile(thumbUrl, THUMB_DIR, thumbFile);
          }

          const gifFile = `${post.id}.gif`;
          const gifPath = path.join(GIF_DIR, gifFile);
          if (!fs.existsSync(gifPath)) await generateGIF(videoPath, gifPath);
        }
      }

      epubChapters.push(formatPostForEPUB(post, thumbnailFile, i));
      previewLinks.push({ title: new Date(post.created_time).toDateString(), thumb: thumbnailFile });
      processedPosts.push(post.id);
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify(processedPosts, null, 2));
      console.log(`Processed post: ${post.id}`);
    }

    // ---------------- Preview / Index Page ----------------
    const previewHtml = previewLinks.map(link =>
      `<p style="text-align:center;">
        <a href="#${link.title.replace(/\s+/g, "_")}">
          <img src="${link.thumb}" alt="${link.title}" style="max-width:200px;height:auto;border:1px solid #ccc;"/>
          <br/>${link.title}
        </a>
      </p>`
    ).join("\n");

    epubChapters.unshift({
      title: "Preview / Index",
      data: `<h1>Preview / Index</h1>${previewHtml}`
    });

    await generateCover();

    const option = {
      title: TITLE,
      author: AUTHOR,
      cover: COVER_PATH,
      output: OUTPUT_EPUB,
      content: epubChapters,
      appendChapterTitles: true
    };

    await new Epub(option).promise;
    console.log("🎉 EPUB generated successfully with TOC, preview page, cover, and video links!");
  } catch (err) {
    console.error("❌ Error:", err);
  }
})();
