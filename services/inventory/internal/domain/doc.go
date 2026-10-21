// Package domain holds Inventory's rules as pure functions, with no I/O (RFC-0001 §4.4, testing strategy §2.1):
// request validation, the reservation status transition table, and stock arithmetic.
// The Postgres store executes the same rules atomically in SQL; this package is the specification it is tested against.
package domain
