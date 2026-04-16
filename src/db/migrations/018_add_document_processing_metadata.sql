-- Add processing/extraction metadata to documents
-- Used to show user-facing status and which OCR engine ran (Ollama/deepseek-ocr vs Tesseract).

ALTER TABLE documents ADD COLUMN processing_status VARCHAR(20) DEFAULT 'uploaded';
ALTER TABLE documents ADD COLUMN processing_error TEXT;
ALTER TABLE documents ADD COLUMN extraction_engine VARCHAR(50);
ALTER TABLE documents ADD COLUMN extraction_metadata TEXT;
ALTER TABLE documents ADD COLUMN processed_at DATETIME;

