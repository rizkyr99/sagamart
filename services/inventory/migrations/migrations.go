// Package migrations embeds the forward-only SQL migrations so the binary can apply them on start.
package migrations

import "embed"

// FS holds every *.sql migration in golang-migrate naming (NNNNNN_name.up.sql).
//
//go:embed *.sql
var FS embed.FS
