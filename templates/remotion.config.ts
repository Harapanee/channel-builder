import path from "node:path";
import { Config } from "@remotion/cli/config";

// episodes/ と assets/ を staticFile() で参照できるよう、public/ 配下に
// シンボリックリンク(public/episodes → ../episodes 等)を置いて配信する。
// publicDir をプロジェクトルートにしてはならない: .env や node_modules が
// studio のHTTP配信・レンダリングバンドルの対象になるため。
// 注: remotion.config.ts はCJSとして評価されるため import.meta は使えない。
// npm scripts は常にプロジェクトルートから実行される前提で process.cwd() を使う。
Config.setPublicDir(path.join(process.cwd(), "public"));
