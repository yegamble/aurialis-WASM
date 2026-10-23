package mastering

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
)

// DecodeReferenceOptionsJSON rejects missing, duplicate, aliased, unknown or null fields.
func DecodeReferenceOptionsJSON(data []byte) (ReferenceOptions, error) {
	var options ReferenceOptions
	if len(data) == 0 || len(data) > 2048 {
		return options, errors.New("reference options require 1..2048 JSON bytes")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := validateTypedJSON(decoder, reflect.TypeFor[ReferenceOptions](), 0); err != nil {
		return options, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return options, errors.New("reference options contain trailing data")
	}
	if err := json.Unmarshal(data, &options); err != nil {
		return options, err
	}
	return options, ValidateReferenceOptions(options)
}
