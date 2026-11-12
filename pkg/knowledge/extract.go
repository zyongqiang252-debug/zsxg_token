package knowledge

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// ExtractText reads text, Markdown, PDF or a DOCX main document without executing
// macros or reading external links. Files are never written to disk here.
func ExtractText(name string, data []byte) (string, error) {
	if len(data) == 0 || len(data) > 2<<20 {
		return "", errors.New("invalid file size")
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".pdf" {
		return extractPDF(data)
	}
	if ext == ".txt" || ext == ".md" {
		if !utf8.Valid(data) || bytes.ContainsRune(data, 0) || utf8.RuneCount(data) > 100_000 {
			return "", errors.New("invalid text document")
		}
		return string(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})), nil
	}
	if ext != ".docx" {
		return "", errors.New("unsupported document type")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(archive.File) > 1000 {
		return "", errors.New("invalid DOCX document")
	}
	var main *zip.File
	for _, item := range archive.File {
		if item.Name == "word/document.xml" {
			if main != nil {
				return "", errors.New("ambiguous DOCX document")
			}
			main = item
		}
	}
	if main == nil || main.UncompressedSize64 > 5<<20 {
		return "", errors.New("invalid DOCX content")
	}
	reader, err := main.Open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(io.LimitReader(reader, (5<<20)+1))
	var out strings.Builder
	inText := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", errors.New("invalid DOCX XML")
		}
		switch part := token.(type) {
		case xml.StartElement:
			if part.Name.Local == "t" {
				inText = true
			}
			if part.Name.Local == "tab" {
				out.WriteByte('\t')
			}
		case xml.EndElement:
			if part.Name.Local == "t" {
				inText = false
			}
			if part.Name.Local == "p" {
				out.WriteByte('\n')
			}
		case xml.CharData:
			if inText {
				out.Write(part)
			}
		}
		if out.Len() > 400_000 {
			return "", errors.New("DOCX text too large")
		}
	}
	text := out.String()
	if utf8.RuneCountInString(text) > 100_000 || strings.TrimSpace(text) == "" {
		return "", errors.New("empty or oversized DOCX text")
	}
	return text, nil
}
