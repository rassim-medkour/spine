package store

import "testing"

func TestGet(t *testing.T) {
	if Get() != 1 {
		t.Fatal("bad")
	}
}
