import { createFileRoute } from "@tanstack/react-router";
import { MoonRace } from "@/game/MoonRace";

export const Route = createFileRoute("/")({ component: MoonRace });
