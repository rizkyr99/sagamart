// Package schematest validates emitted events against the contract schemas in contracts/events
// (testing strategy §3: producers test what they emit). Test use only.
package schematest

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const baseURL = "https://sagamart.dev/schemas/events/"

// Validate fails the test unless payload is a valid event of the given type, version 1.
func Validate(t testing.TB, eventType string, payload []byte) {
	t.Helper()
	dir := eventsDir(t)

	c := jsonschema.NewCompiler()
	c.AssertFormat()
	add := func(url, path string) {
		doc := load(t, path)
		if err := c.AddResource(url, doc); err != nil {
			t.Fatalf("add schema %s: %v", path, err)
		}
	}
	add(baseURL+"envelope.schema.json", filepath.Join(dir, "envelope.schema.json"))
	name := eventType + ".v1.schema.json"
	add(baseURL+"schemas/"+name, filepath.Join(dir, "schemas", name))

	schema, err := c.Compile(baseURL + "schemas/" + name)
	if err != nil {
		t.Fatalf("compile %s: %v", name, err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("event is not JSON: %v\n%s", err, payload)
	}
	if err := schema.Validate(inst); err != nil {
		t.Errorf("event does not match %s:\n%v\n%s", name, err, payload)
	}
}

func load(t testing.TB, path string) any {
	t.Helper()
	f, err := os.Open(path) //nolint:gosec // G304: test-only; path is derived from this source file's location
	if err != nil {
		t.Fatalf("open schema: %v", err)
	}
	defer f.Close()
	doc, err := jsonschema.UnmarshalJSON(f)
	if err != nil {
		t.Fatalf("parse schema %s: %v", path, err)
	}
	return doc
}

// eventsDir finds contracts/events by walking up from this source file.
func eventsDir(t testing.TB) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	for dir := filepath.Dir(file); dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "contracts", "events")
		if _, err := os.Stat(filepath.Join(candidate, "envelope.schema.json")); err == nil {
			return candidate
		}
	}
	t.Fatal("contracts/events not found above " + file)
	return ""
}
