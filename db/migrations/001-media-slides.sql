-- Slides (slide-editor JSON) in the media library: the media item is the rendered PNG, `source` says it was made from
-- a slide, whose JSON is stored next to the PNG (storage/media/<account>/<id>.slide.json).
ALTER TABLE media ADD COLUMN source ENUM('file','slide') NOT NULL DEFAULT 'file' AFTER extension;
