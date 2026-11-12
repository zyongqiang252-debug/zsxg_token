package knowledge

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

const pdfWorkerEnvironment = "XINGUANG_INTERNAL_PDF_WORKER"

var pdfWorkers = make(chan struct{}, 2)

// A separate short-lived process contains parser panics and timeouts. It is not
// a substitute for an operating-system sandbox around hostile file parsing.
func init() {
	if os.Getenv(pdfWorkerEnvironment) != "1" {
		return
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		os.Exit(1)
	}
	text, err := parsePDF(data)
	if err != nil {
		os.Exit(1)
	}
	if _, err := io.WriteString(os.Stdout, text); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func parsePDF(data []byte) (string, error) {
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		return "", errors.New("invalid PDF")
	}
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", errors.New("invalid PDF")
	}
	if pages := r.NumPage(); pages < 1 || pages > 100 {
		return "", errors.New("unsupported PDF page count")
	}
	reader, err := r.GetPlainText()
	if err != nil {
		return "", errors.New("cannot extract PDF text")
	}
	output, err := io.ReadAll(io.LimitReader(reader, 400_001))
	if err != nil || len(output) > 400_000 || !utf8.Valid(output) {
		return "", errors.New("empty or oversized PDF text")
	}
	// Some PDF font mappings include U+0000. It is not usable text and is
	// rejected by PostgreSQL, so remove it before storage or retrieval.
	text := strings.ReplaceAll(string(output), "\x00", "")
	if utf8.RuneCountInString(text) > 100_000 || strings.TrimSpace(text) == "" {
		return "", errors.New("empty or oversized PDF text")
	}
	return text, nil
}

func extractPDF(data []byte) (string, error) {
	select {
	case pdfWorkers <- struct{}{}:
		defer func() { <-pdfWorkers }()
	default:
		return "", errors.New("PDF parser is busy")
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable)
	cmd.Env = []string{pdfWorkerEnvironment + "=1", "GOMEMLIMIT=128MiB", "GOMAXPROCS=1"}
	if root := os.Getenv("SYSTEMROOT"); root != "" {
		cmd.Env = append(cmd.Env, "SYSTEMROOT="+root)
	}
	cmd.Stdin = bytes.NewReader(data)
	output, err := cmd.Output()
	if err != nil || len(output) > 400_000 || !utf8.Valid(output) || strings.TrimSpace(string(output)) == "" {
		return "", errors.New("PDF extraction failed")
	}
	return string(output), nil
}
