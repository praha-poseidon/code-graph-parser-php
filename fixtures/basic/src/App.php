<?php

namespace App;

function helper(int $value): int
{
    return $value + 1;
}

#[Route('/api')]
class Service
{
    #[Route('/run', methods: ['GET'])]
    public function run(): int
    {
        $redis->get('demo:key');
        return helper(41);
    }
}

$bootValue = helper(1);
