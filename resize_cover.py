from PIL import Image
import os

# Paths
input_path = r"C:\Users\onyek\Facebook-Video-Posts-EPUB\ebook_assets\cover.jpg"
output_path = r"C:\Users\onyek\Facebook-Video-Posts-EPUB\ebook_assets\cover_kdp.jpg"

# KDP recommended size
kdp_width = 1600
kdp_height = 2560

# Open and resize image
with Image.open(input_path) as img:
    img = img.convert("RGB")  # Ensure JPEG compatible
    img_resized = img.resize((kdp_width, kdp_height), Image.LANCZOS)
    img_resized.save(output_path, "JPEG", quality=95)

print(f"[Success] Cover resized for KDP: {output_path}")
