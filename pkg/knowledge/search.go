// Package knowledge contains bounded, local document retrieval primitives.
package knowledge

import (
	"errors"
	"sort"
	"strings"
	"unicode"
)

type Document struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Text string `json:"text"`
}

type Match struct {
	DocumentID string `json:"document_id"`
	Name       string `json:"name"`
	Text       string `json:"text"`
	Start      int    `json:"start_rune"`
	End        int    `json:"end_rune"`
	Score      int    `json:"score"`
}

// terms makes English words and overlapping Chinese bigrams searchable.
func terms(text string) map[string]struct{} {
	result := map[string]struct{}{}
	var latin []rune
	var han []rune
	flush := func() {
		if len(latin) > 1 {
			result[string(latin)] = struct{}{}
		}
		latin = nil
		if len(han) == 1 {
			result[string(han)] = struct{}{}
		}
		for i := 0; i+1 < len(han); i++ {
			result[string(han[i:i+2])] = struct{}{}
		}
		han = nil
	}
	for _, r := range strings.ToLower(text) {
		switch {
		case unicode.Is(unicode.Han, r):
			if len(latin) != 0 {
				flush()
			}
			han = append(han, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if len(han) != 0 {
				flush()
			}
			latin = append(latin, r)
		default:
			flush()
		}
	}
	flush()
	return result
}

// Search ranks fixed-size overlapping chunks, retaining source offsets.
// Callers must supply only documents the current user is authorized to read.
func Search(query string, docs []Document, limit int) ([]Match, error) {
	if len([]rune(query)) > 1000 || len(docs) > 20 || limit < 1 || limit > 10 {
		return nil, errors.New("invalid retrieval request")
	}
	q := terms(query)
	if len(q) == 0 {
		return []Match{}, nil
	}
	var matches []Match
	for _, doc := range docs {
		text := []rune(doc.Text)
		if doc.ID == "" || len(text) > 100_000 {
			return nil, errors.New("invalid document")
		}
		for start := 0; start < len(text); start += 520 {
			end := min(start+600, len(text))
			chunk := string(text[start:end])
			count := 0
			for term := range terms(chunk) {
				if _, found := q[term]; found {
					count++
				}
			}
			if count > 0 {
				matches = append(matches, Match{doc.ID, doc.Name, chunk, start, end, count})
			}
			if end == len(text) {
				break
			}
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].Score > matches[j].Score })
	if len(matches) > limit {
		matches = matches[:limit]
	}
	if matches == nil {
		matches = []Match{}
	}
	return matches, nil
}
