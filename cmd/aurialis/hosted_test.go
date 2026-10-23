package main

import (
	"strings"
	"testing"
)

func TestHostedListenerRequiresExplicitCompleteConfiguration(t *testing.T) {
	for _, address := range []string{"0.0.0.0:8080", "[::]:8080", "192.168.1.2:8080", "localhost:8080", ":8080"} {
		if validateListenAddress(address, false) == nil {
			t.Fatalf("default startup accepted nonloopback %s", address)
		}
	}
	for _, address := range []string{"127.0.0.1:8080", "[::1]:8080"} {
		if err := validateListenAddress(address, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := resolveHostedConfig(false, "https://aurialis.yosefgamble.com", ""); err == nil {
		t.Fatal("public origins silently enabled hosted mode")
	}
	for _, secret := range []string{"", "short", strings.Repeat("Z", 64)} {
		if _, err := resolveHostedConfig(true, "https://aurialis.yosefgamble.com", secret); err == nil {
			t.Fatal("partial hosted configuration accepted")
		}
	}
	cfg, err := resolveHostedConfig(true, "https://aurialis.yosefgamble.com,https://aurialis.yosef.app", strings.Repeat("a", 64))
	if err != nil || cfg == nil || validateListenAddress("0.0.0.0:8080", true) != nil {
		t.Fatalf("complete explicit hosted configuration rejected: %v", err)
	}
}
