package knowledge

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSearchReturnsRelevantSourceAndOffsets(t *testing.T) {
	docs := []Document{{"one", "research.txt", strings.Repeat("无关内容", 150) + "营收增长利润改善"}, {"two", "other.txt", "另一份文档"}}
	result, err := Search("营收增长", docs, 3)
	require.NoError(t, err)
	require.Len(t, result, 1)
	assert.Equal(t, "one", result[0].DocumentID)
	assert.Contains(t, result[0].Text, "营收增长")
	assert.Equal(t, result[0].Text, string([]rune(docs[0].Text)[result[0].Start:result[0].End]))
	result, err = Search("unrelated", docs, 3)
	require.NoError(t, err)
	assert.Empty(t, result)
}

func TestSearchRejectsOversizedOrUnidentifiedDocuments(t *testing.T) {
	_, err := Search("word", []Document{{ID: "a", Text: strings.Repeat("x", 100001)}}, 2)
	assert.Error(t, err)
	_, err = Search("word", []Document{{Text: "word"}}, 2)
	assert.Error(t, err)
}
