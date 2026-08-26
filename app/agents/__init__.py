"""Talking to the CLI coding agents a user already subscribes to.

Each CLI speaks its own dialect. A translator per CLI turns that dialect into
the five events the rest of the app knows -- start, progress, text, done,
error -- so the chat panel never learns a vendor's format.
"""
