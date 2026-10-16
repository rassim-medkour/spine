package api

import s "example.com/fx/internal/store"

func H() int { return s.Get() }
