package knowledge

import (
	"archive/zip"
	"bytes"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractTextAndDocx(t *testing.T) {
	text, err := ExtractText("notes.md", []byte("收益增长"))
	require.NoError(t, err)
	assert.Equal(t, "收益增长", text)
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	w, err := z.Create("word/document.xml")
	require.NoError(t, err)
	_, err = w.Write([]byte(`<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>营收</w:t></w:r><w:r><w:t>增长</w:t></w:r></w:p></w:body></w:document>`))
	require.NoError(t, err)
	require.NoError(t, z.Close())
	text, err = ExtractText("report.docx", buf.Bytes())
	require.NoError(t, err)
	assert.Equal(t, "营收增长\n", text)
	_, err = ExtractText("report.pdf", []byte("%PDF"))
	assert.Error(t, err)
	_, err = ExtractText("report.docx", []byte("not a zip"))
	assert.Error(t, err)
}

func TestExtractPDFTextInWorker(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	objects := []string{
		`<< /Type /Catalog /Pages 2 0 R >>`,
		`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
		`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
	}
	stream := "BT /F1 12 Tf 72 720 Td (Revenue grows) Tj ET"
	objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	text, err := ExtractText("report.pdf", b.Bytes())
	require.NoError(t, err)
	assert.Contains(t, text, "Revenue grows")
	assert.NotContains(t, text, "\x00")
}
