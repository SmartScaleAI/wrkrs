Malformed documents used to prove that parser diagnostics never echo source
text. Every `ZQX_*` token is a short fake sentinel positioned where a YAML or
JSON parser would normally quote the surrounding text.
