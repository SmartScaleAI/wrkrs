# legacy-manifest

An ownership manifest exactly as wrkrs 0.1.0 wrote it, before schema version 2
added the installation `state` field. It is committed so the version 1 reader
and its migration keep being exercised against a real artifact rather than a
document the tests construct for themselves.

The content hash is a placeholder: this fixture proves parsing and migration,
not ownership of any particular file.
