<?php

namespace App;

interface Gateway
{
    public function send(string $value): string;
}

interface ChildGateway extends Gateway
{
    public function receive(): string;
}

trait Logs
{
    public function log(): void {}
}

abstract class Base
{
    public function run(): void {}

    private function hidden(): void {}
}

class Service extends Base implements ChildGateway
{
    use Logs;

    public function run(): void {}

    public function send(string $value): string
    {
        return $value;
    }

    public function receive(): string
    {
        return 'ok';
    }

    public function hidden(): void {}
}

class Unrelated
{
    public function send(string $value): string
    {
        return $value;
    }
}
