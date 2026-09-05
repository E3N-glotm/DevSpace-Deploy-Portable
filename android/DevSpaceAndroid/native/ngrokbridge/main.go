package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.ngrok.com/ngrok/v2"
)

const runtimeVersion = "devspace-ngrok-sdk-2.1.4"

type launchConfig struct {
	Authtoken string `json:"authtoken"`
	URL       string `json:"url"`
	Upstream  string `json:"upstream"`
}

func emit(event string, fields map[string]any) {
	message := map[string]any{"event": event, "runtime": runtimeVersion}
	for key, value := range fields {
		message[key] = value
	}
	encoded, _ := json.Marshal(message)
	fmt.Println(string(encoded))
}

func errorCode(err error) string {
	type coded interface{ Code() string }
	if value, ok := err.(coded); ok {
		return value.Code()
	}
	return ""
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(runtimeVersion)
		return
	}

	var cfg launchConfig
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&cfg); err != nil {
		emit("error", map[string]any{"stage": "config", "message": err.Error()})
		os.Exit(2)
	}
	cfg.Authtoken = strings.TrimSpace(cfg.Authtoken)
	cfg.URL = strings.TrimSpace(cfg.URL)
	cfg.Upstream = strings.TrimSpace(cfg.Upstream)
	if cfg.Authtoken == "" || cfg.Upstream == "" {
		emit("error", map[string]any{"stage": "config", "message": "authtoken and upstream are required"})
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	agent, err := ngrok.NewAgent(
		ngrok.WithAuthtoken(cfg.Authtoken),
		ngrok.WithClientInfo("devspace-mobile", runtimeVersion, "android-arm64"),
	)
	if err != nil {
		emit("error", map[string]any{"stage": "agent", "message": err.Error(), "code": errorCode(err)})
		os.Exit(3)
	}

	upstream := ngrok.WithUpstream(cfg.Upstream)
	options := []ngrok.EndpointOption{}
	if cfg.URL != "" {
		options = append(options, ngrok.WithURL(cfg.URL))
	}
	forwarder, err := agent.Forward(ctx, upstream, options...)
	if err != nil {
		emit("error", map[string]any{"stage": "forward", "message": err.Error(), "code": errorCode(err)})
		os.Exit(4)
	}

	emit("online", map[string]any{"url": forwarder.URL(), "upstream": cfg.Upstream})
	select {
	case <-ctx.Done():
		emit("stopped", map[string]any{"reason": "signal"})
	case <-forwarder.Done():
		emit("stopped", map[string]any{"reason": "forwarder_done"})
	}
}
